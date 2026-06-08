/**
 * Resolve parcel IDs for lead sources that have street addresses.
 *
 * Uses Richland County ArcGIS Parcel_CAMA (no auth).
 * Updates probate day files, eviction/code-violation month files, and canonical JSON/CSV.
 *
 * Usage:
 *   npm run enrich:parcel-ids
 *   node scripts/enrich-parcel-ids.mjs --source probate
 *   node scripts/enrich-parcel-ids.mjs --limit 20
 *   node scripts/enrich-parcel-ids.mjs --force
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadAllDayRecords,
  loadAllMonthRecords,
  writeCanonicalFromDays,
  writeCanonicalFromMonths,
  mergeByKey,
  toCsv,
} from "./scrape-state.mjs";
import { personPartyNames } from "../src/core/name-match.mjs";
import {
  lookupParcelByAddress,
  lookupParcelByOwnerName,
  applyParcelLookup,
  recordStreet,
} from "./auditor-gis.mjs";
import { paths } from "../src/core/county-context.mjs";

const p = paths();
const DATA_DIR = p.dataRoot;
const REPORT_PATH = p.file("parcel-enrichment-report.json");
const CACHE_PATH = p.file("parcel-lookup-cache.json");

function loadDiskCache() {
  const cache = new Map();
  if (!fs.existsSync(CACHE_PATH)) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    for (const [key, value] of Object.entries(raw)) cache.set(key, value);
  } catch {
    // ignore corrupt cache
  }
  return cache;
}

function saveDiskCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(cache.entries()), null, 2));
}

const SOURCE_CONFIG = {
  "probate-estates": {
    load: (keyFn) => loadAllDayRecords("probate-estates", keyFn),
    writeCanonical: (keyFn) => writeCanonicalFromDays("probate-estates", keyFn),
    rewriteFiles: rewriteDayFiles,
    keyFn: (r) => r.case_number,
  },
  evictions: {
    load: (keyFn) => loadAllMonthRecords("evictions", keyFn),
    writeCanonical: (keyFn) => writeCanonicalFromMonths("evictions", keyFn),
    rewriteFiles: rewriteMonthFiles,
    keyFn: (r) => r.case_number ?? r.case_id,
  },
  "code-violations": {
    load: (keyFn) => loadAllMonthRecords("code-violations", keyFn),
    writeCanonical: (keyFn) => writeCanonicalFromMonths("code-violations", keyFn),
    rewriteFiles: rewriteMonthFiles,
    keyFn: (r) => r.record_number ?? r.record_id,
  },
};

function addressVariants(street) {
  if (!street) return [];
  const variants = [street];
  const withoutLot = street.replace(/\s+LOT\s+[\w-]+.*$/i, "").trim();
  if (withoutLot && withoutLot !== street) variants.push(withoutLot);
  const withoutUnit = street.replace(/\s+(?:APT|APARTMENT|UNIT|STE|SUITE|#)\s*\S+.*$/i, "").trim();
  if (withoutUnit && withoutUnit !== street && !variants.includes(withoutUnit)) variants.push(withoutUnit);
  return [...new Set(variants)];
}

function ownerNameForRecord(record, sourceId) {
  switch (sourceId) {
    case "evictions":
      return personPartyNames(record.defendant_names ?? record.label ?? "")[0] ?? null;
    case "probate-estates":
      return personPartyNames(record.decedent_name ?? record.label ?? "")[0] ?? null;
    case "code-violations":
      return personPartyNames(record.owner_name ?? record.applicant_name ?? "")[0] ?? null;
    default:
      return null;
  }
}

async function lookupAddressVariants(street, cache, options) {
  let last = { status: "not_found", match: null, candidates: [] };
  for (const variant of addressVariants(street)) {
    const lookup = await lookupParcelByAddress(variant, cache, options);
    last = lookup;
    if (lookup.status === "matched") return { lookup, variant };
    if (lookup.status === "ambiguous") return { lookup, variant };
  }
  return { lookup: last, variant: street };
}

function applyOwnerLookup(record, lookup, source) {
  if (lookup.status === "matched" && lookup.match) {
    return {
      ...record,
      parcel_id: lookup.match.parcel_id,
      auditor_parcel_address: lookup.match.parcel_address ?? null,
      auditor_owner_name: lookup.match.owner_name ?? null,
      parcel_lookup: "matched",
      parcel_match_source: source,
      parcel_match_score: lookup.match.match_score ?? null,
    };
  }
  if (lookup.status === "ambiguous") {
    return {
      ...record,
      parcel_lookup: "ambiguous",
      parcel_candidates: lookup.candidates,
      parcel_match_source: source,
    };
  }
  return { ...record, parcel_lookup: record.parcel_lookup ?? "not_found", parcel_match_source: source };
}

function needsParcelResolution(record, sourceId, { force = false } = {}) {
  if (force) return true;
  if (record.parcel_id) return false;
  return Boolean(recordStreet(record) || ownerNameForRecord(record, sourceId));
}

function parseArgs() {
  const sourceIdx = process.argv.indexOf("--source");
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;
  const source = sourceIdx >= 0 ? process.argv[sourceIdx + 1] : "all";
  return {
    force: process.argv.includes("--force"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    source,
  };
}

function rewriteDayFiles(baseName, enrichedByKey, keyFn) {
  const prefix = `${baseName}-day-`;
  for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
    const filePath = path.join(DATA_DIR, file);
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const updated = rows.map((row) => enrichedByKey.get(keyFn(row)) ?? row);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    fs.writeFileSync(filePath.replace(/\.json$/, ".csv"), toCsv(updated));
  }
}

function rewriteMonthFiles(baseName, enrichedByKey, keyFn) {
  const prefix = `${baseName}-month-`;
  for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
    const filePath = path.join(DATA_DIR, file);
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const updated = rows.map((row) => enrichedByKey.get(keyFn(row)) ?? row);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    fs.writeFileSync(filePath.replace(/\.json$/, ".csv"), toCsv(updated));
  }
}

async function enrichSource(sourceId, config, options, cache, report) {
  const records = config.load(config.keyFn);
  let todo = records.filter((r) => needsParcelResolution(r, sourceId, { force: options.force }));
  if (options.limit) todo = todo.slice(0, options.limit);

  console.error(`\n=== ${sourceId} ===`);
  console.error(`  Records: ${records.length}, to lookup: ${todo.length}`);

  const enrichedByKey = new Map(records.map((r) => [config.keyFn(r), r]));
  const stats = { matched: 0, not_found: 0, ambiguous: 0, skipped: 0, owner_matched: 0 };

  let dnsFailure = false;

  for (let i = 0; i < todo.length; i++) {
    const record = todo[i];
    const street = recordStreet(record);
    const ownerName = ownerNameForRecord(record, sourceId);
    const label = `${i + 1}/${todo.length} ${config.keyFn(record)}`;
    try {
      let merged = record;
      let status = "not_found";

      if (street) {
        const { lookup, variant } = await lookupAddressVariants(street, cache, { delayMs: 50 });
        merged = applyParcelLookup(record, lookup);
        if (variant !== street) merged.address_lookup_variant = variant;
        status = lookup.status;
      }

      if (status !== "matched" && status !== "ambiguous" && ownerName) {
        const byOwner = await lookupParcelByOwnerName(ownerName, cache, { delayMs: 50 });
        merged = applyOwnerLookup(merged, byOwner, "gis_owner");
        if (byOwner.status === "matched") {
          stats.owner_matched++;
          status = "matched";
        } else if (byOwner.status === "ambiguous") {
          status = "ambiguous";
        }
      }

      enrichedByKey.set(config.keyFn(record), merged);
      if (status === "matched") stats.matched++;
      else if (status === "ambiguous") stats.ambiguous++;
      else stats.not_found++;

      if (status === "matched") {
        console.error(`  ${label} → ${merged.parcel_id}`);
      } else {
        console.error(`  ${label} → ${status}`);
        report.unmatched.push({
          source: sourceId,
          key: config.keyFn(record),
          address: street,
          owner_name: ownerName,
          city: record.city ?? null,
          status,
          candidates: merged.parcel_candidates ?? [],
        });
      }
    } catch (err) {
      stats.skipped++;
      const code = err?.cause?.code ?? err?.code ?? "";
      if (code === "ENOTFOUND" || code === "ENETUNREACH" || code === "EAI_AGAIN") {
        dnsFailure = true;
      }
      report.errors.push({
        source: sourceId,
        key: config.keyFn(record),
        address: street,
        error: err.message,
        code: code || null,
      });
      console.error(`  ${label} → error: ${err.message}`);
      if (dnsFailure) {
        console.error("  GIS API unreachable — stopping this source early.");
        break;
      }
    }

    if ((i + 1) % 25 === 0) saveDiskCache(cache);
  }

  saveDiskCache(cache);

  config.rewriteFiles(sourceId, enrichedByKey, config.keyFn);
  const { canonical, canonicalJson, canonicalCsv } = config.writeCanonical(config.keyFn);

  console.error(`  Matched:   ${stats.matched} (${stats.owner_matched} via owner name)`);
  console.error(`  Not found: ${stats.not_found}`);
  console.error(`  Ambiguous: ${stats.ambiguous}`);
  if (stats.skipped) console.error(`  Errors:    ${stats.skipped}`);
  console.error(`  Canonical: ${canonical.filter((r) => r.parcel_id).length}/${canonical.length} with parcel_id`);
  console.error(`  Wrote ${canonicalJson}`);

  report.sources[sourceId] = {
    total: canonical.length,
    with_parcel_id: canonical.filter((r) => r.parcel_id).length,
    ...stats,
  };

  return canonical;
}

async function main() {
  const options = parseArgs();
  const cache = loadDiskCache();
  const report = {
    generated_at: new Date().toISOString(),
    sources: {},
    unmatched: [],
    errors: [],
  };

  const sourceIds =
    options.source === "all"
      ? Object.keys(SOURCE_CONFIG)
      : [options.source].filter((id) => SOURCE_CONFIG[id]);

  if (sourceIds.length === 0) {
    throw new Error(`Unknown source "${options.source}". Use probate-estates, evictions, code-violations, or all.`);
  }

  console.error(`Parcel ID enrichment via Richland County GIS`);
  console.error(`Sources: ${sourceIds.join(", ")}`);

  for (const sourceId of sourceIds) {
    await enrichSource(sourceId, SOURCE_CONFIG[sourceId], options, cache, report);
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.error(`\nWrote report ${REPORT_PATH}`);
  console.error(`Unique address lookups: ${cache.size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

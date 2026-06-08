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
import {
  lookupParcelByAddress,
  applyParcelLookup,
  needsParcelLookup,
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
  let todo = records.filter((r) => needsParcelLookup(r, { force: options.force }));
  if (options.limit) todo = todo.slice(0, options.limit);

  console.error(`\n=== ${sourceId} ===`);
  console.error(`  Records: ${records.length}, to lookup: ${todo.length}`);

  const enrichedByKey = new Map(records.map((r) => [config.keyFn(r), r]));
  const stats = { matched: 0, not_found: 0, ambiguous: 0, skipped: 0 };

  let dnsFailure = false;

  for (let i = 0; i < todo.length; i++) {
    const record = todo[i];
    const street = recordStreet(record);
    const label = `${i + 1}/${todo.length} ${config.keyFn(record)}`;
    try {
      const lookup = await lookupParcelByAddress(street, cache, { delayMs: 50 });
      const merged = applyParcelLookup(record, lookup);
      enrichedByKey.set(config.keyFn(record), merged);
      stats[lookup.status === "matched" ? "matched" : lookup.status]++;

      if (lookup.status === "matched") {
        console.error(`  ${label} → ${lookup.match.parcel_id}`);
      } else {
        console.error(`  ${label} → ${lookup.status}`);
        report.unmatched.push({
          source: sourceId,
          key: config.keyFn(record),
          address: street,
          city: record.city ?? null,
          status: lookup.status,
          candidates: lookup.candidates ?? [],
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

  console.error(`  Matched:   ${stats.matched}`);
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

/**
 * Resolve parcel_id for lis-pendens: legal text → GIS defendant/grantor owner lookup.
 *
 * Usage:
 *   npm run enrich:lis-pendens
 *   node scripts/enrich-lis-pendens-parcels.mjs --force
 *   node scripts/enrich-lis-pendens-parcels.mjs --limit 20
 */

import fs from "fs";
import { paths } from "../src/core/county-context.mjs";
import { extractParcelFromText } from "../src/core/parcel-id.mjs";
import { personPartyNames } from "../src/core/name-match.mjs";
import { loadCanonicalRecords, toCsv } from "./scrape-state.mjs";
import { lookupParcelByOwnerName } from "./auditor-gis.mjs";

const p = paths();
const CANONICAL = p.file("lis-pendens-canonical.json");
const REPORT = p.file("lis-pendens-parcel-report.json");
const CACHE_PATH = p.file("parcel-lookup-cache.json");

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;
  return {
    force: process.argv.includes("--force"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
  };
}

function loadDiskCache() {
  const cache = new Map();
  if (!fs.existsSync(CACHE_PATH)) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    for (const [key, value] of Object.entries(raw)) cache.set(key, value);
  } catch {
    // ignore
  }
  return cache;
}

function saveDiskCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(cache.entries()), null, 2));
}

function extractParcel(record) {
  return extractParcelFromText(
    record.legal_description,
    record.remarks,
    record.reference,
    record.municipality
  );
}

function partyCandidates(record) {
  const defendants = personPartyNames(record.defendant_names);
  const grantors = personPartyNames(record.grantor_names);
  const seen = new Set();
  const out = [];
  for (const name of [...defendants, ...grantors]) {
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, role: defendants.includes(name) ? "defendant" : "grantor" });
  }
  return out;
}

function applyOwnerLookup(record, lookup, source, partyName) {
  if (lookup.status === "matched" && lookup.match) {
    return {
      ...record,
      parcel_id: lookup.match.parcel_id,
      property_address: lookup.match.parcel_address ?? null,
      auditor_parcel_address: lookup.match.parcel_address ?? null,
      auditor_owner_name: lookup.match.owner_name ?? null,
      parcel_id_source: source,
      parcel_match_party: partyName,
      parcel_lookup: "matched",
    };
  }
  if (lookup.status === "ambiguous") {
    return {
      ...record,
      parcel_lookup: "ambiguous",
      parcel_candidates: lookup.candidates,
      parcel_id_source: source,
      parcel_match_party: partyName,
    };
  }
  return record;
}

async function resolveParcel(record, cache, report, { force = false } = {}) {
  if (record.parcel_id && !force) return { record, method: "existing" };

  const fromLegal = extractParcel(record);
  if (fromLegal) {
    return {
      record: {
        ...record,
        parcel_id: fromLegal,
        parcel_id_source: "legal_description",
        parcel_lookup: "matched",
      },
      method: "legal_description",
    };
  }

  const parties = partyCandidates(record);
  for (const { name, role } of parties) {
    try {
      const lookup = await lookupParcelByOwnerName(name, cache, { delayMs: 50 });
      if (lookup.status === "matched") {
        return {
          record: applyOwnerLookup(record, lookup, `gis_owner_${role}`, name),
          method: `gis_owner_${role}`,
        };
      }
      if (lookup.status === "ambiguous") {
        report.ambiguous.push({
          instrument_number: record.instrument_number,
          party: name,
          role,
          candidates: lookup.candidates,
        });
        return {
          record: applyOwnerLookup(record, lookup, `gis_owner_${role}`, name),
          method: "ambiguous",
        };
      }
    } catch (err) {
      report.errors.push({
        instrument_number: record.instrument_number,
        party: name,
        error: err.message,
      });
      throw err;
    }
  }

  report.unmatched.push({
    instrument_number: record.instrument_number,
    defendant_names: record.defendant_names,
    grantor_names: record.grantor_names,
    legal_description: record.legal_description,
    parties_tried: parties.map((p) => p.name),
  });
  return { record, method: "not_found" };
}

async function main() {
  const options = parseArgs();
  const records = loadCanonicalRecords("lis-pendens-canonical.json");
  const cache = loadDiskCache();
  const report = {
    generated_at: new Date().toISOString(),
    methods: {},
    ambiguous: [],
    unmatched: [],
    errors: [],
  };

  let todo = records.filter((r) => options.force || !r.parcel_id);
  if (options.limit) todo = todo.slice(0, options.limit);

  console.error("Lis pendens parcel enrichment");
  console.error(`  Total: ${records.length}, to resolve: ${todo.length}`);

  const enrichedByKey = new Map(records.map((r) => [r.instrument_number ?? r.instrument_id, r]));

  for (let i = 0; i < todo.length; i++) {
    const key = todo[i].instrument_number ?? todo[i].instrument_id;
    const { record, method } = await resolveParcel(todo[i], cache, report, options);
    enrichedByKey.set(key, record);
    report.methods[method] = (report.methods[method] ?? 0) + 1;
    const label = `${i + 1}/${todo.length} ${key}`;
    if (record.parcel_id) {
      console.error(`  ${label} → ${record.parcel_id} (${record.parcel_id_source})`);
    } else {
      console.error(`  ${label} → no parcel`);
    }
    if ((i + 1) % 10 === 0) saveDiskCache(cache);
  }

  saveDiskCache(cache);
  const enriched = records.map((r) => enrichedByKey.get(r.instrument_number ?? r.instrument_id) ?? r);

  fs.writeFileSync(CANONICAL, JSON.stringify(enriched, null, 2));
  fs.writeFileSync(CANONICAL.replace(/\.json$/, ".csv"), toCsv(enriched));

  report.total = enriched.length;
  report.with_parcel_id = enriched.filter((r) => r.parcel_id).length;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.error(`  With parcel_id:  ${report.with_parcel_id}/${report.total}`);
  console.error(`  Methods:         ${JSON.stringify(report.methods)}`);
  console.error(`  Wrote ${CANONICAL}`);
  console.error(`  Wrote ${REPORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

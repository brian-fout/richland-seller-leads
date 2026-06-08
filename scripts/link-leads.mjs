/**
 * @county richland — Cross-link distress lead sources on parcel_id.
 *
 * Idempotent: rebuilds from current canonical files each run.
 * Manual parcel_id fixes in source files are picked up on re-run.
 *
 * Usage: npm run link:leads
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths } from "../src/core/county-context.mjs";
import { findLatestTaxLienJson } from "../src/core/tax-lien-discovery.mjs";
import { normalizeParcelId as normalizeParcelIdCore } from "../src/core/parcel-id.mjs";
import { loadCanonicalRecords, toCsv } from "./scrape-state.mjs";

const p = paths();
const DATA_DIR = p.dataRoot;
const LINKS_JSON = p.leadLinks;
const LINKS_CSV = p.leadLinksCsv;
const INDEX_JSON = p.leadParcelIndex;

const SOURCE_LOADERS = {
  "tax-liens": loadTaxLiens,
  "probate-estates": () => loadCanonicalRecords("probate-estates-canonical.json"),
  evictions: () => loadCanonicalRecords("evictions-canonical.json"),
  "code-violations": () => loadCanonicalRecords("code-violations-canonical.json"),
  "clerk-foreclosures": () => loadCanonicalRecords("clerk-foreclosures-canonical.json"),
  "sheriff-sales": loadSheriffSales,
  "lis-pendens": () => loadCanonicalRecords("lis-pendens-canonical.json"),
};

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeParcelId(value) {
  return normalizeParcelIdCore(value);
}

function loadTaxLiens() {
  const latest = findLatestTaxLienJson(DATA_DIR);
  const file = latest?.path ?? path.join(DATA_DIR, "tax-lien-list-10-21-2025.json");
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = [];
  for (const district of raw.districts ?? []) {
    for (const parcel of district.parcels ?? []) {
      rows.push({
        ...parcel,
        source: "tax_liens",
        district_code: district.code,
        district_name: district.name,
      });
    }
  }
  return rows;
}

function loadSheriffSales() {
  const canonical = loadCanonicalRecords("pre-foreclosure-canonical.json");
  if (canonical.length) return canonical;

  const dated = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("pre-foreclosure-") && f.endsWith(".json") && !f.includes("canonical"))
    .sort()
    .reverse();
  if (!dated.length) return [];
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, dated[0]), "utf8"));
  return raw.records ?? [];
}

function sourceKey(record, sourceId) {
  switch (sourceId) {
    case "tax-liens":
      return record.parcel_id ?? record.stub ?? null;
    case "probate-estates":
      return record.case_number ?? null;
    case "evictions":
      return record.case_number ?? record.case_id ?? null;
    case "code-violations":
      return record.record_number ?? record.record_id ?? null;
    case "clerk-foreclosures":
      return record.case_number ?? null;
    case "sheriff-sales":
      return record.case_number ?? record.parcel_id ?? null;
    case "lis-pendens":
      return record.instrument_number ?? record.instrument_id ?? null;
    default:
      return null;
  }
}

function compactRecord(record, sourceId) {
  const base = {
    source: sourceId,
    source_key: sourceKey(record, sourceId),
    parcel_id: normalizeParcelId(record.parcel_id),
    address:
      clean(
        record.property_address ??
          record.street_address ??
          record.parcel_address ??
          record.auditor_parcel_address
      ) || null,
    city: clean(record.city) || null,
    file_date:
      clean(record.file_date ?? record.recorded_date ?? record.updated_date ?? record.auction_datetime) ||
      null,
    status: clean(record.status ?? record.auction_status ?? record.cert_status) || null,
    label: null,
  };

  switch (sourceId) {
    case "tax-liens":
      base.label = clean(record.owner_name);
      base.delinquent_year = record.delinquent_year ?? null;
      base.cert_status = record.cert_status ?? null;
      break;
    case "probate-estates":
      base.label = clean(record.decedent_name);
      break;
    case "evictions":
      base.label = clean(record.defendant_names ?? record.plaintiff_name);
      break;
    case "code-violations":
      base.label = clean(record.record_type ?? record.description);
      break;
    case "clerk-foreclosures":
      base.label = clean(record.case_style ?? record.defendant);
      base.case_description = record.case_description ?? null;
      break;
    case "sheriff-sales":
      base.label = clean(record.property_address);
      base.case_number = record.case_number ?? null;
      break;
    case "lis-pendens":
      base.label = clean(record.defendant_names ?? record.grantor_names);
      break;
    default:
      break;
  }

  return base;
}

function bestAddress(recordsBySource) {
  const order = [
    "sheriff-sales",
    "lis-pendens",
    "clerk-foreclosures",
    "evictions",
    "code-violations",
    "probate-estates",
    "tax-liens",
  ];
  for (const sourceId of order) {
    const hit = recordsBySource[sourceId]?.find((r) => r.address);
    if (hit) return { address: hit.address, city: hit.city, from: sourceId };
  }
  return { address: null, city: null, from: null };
}

function pairKey(a, b) {
  return [a, b].sort().join("+");
}

function buildOverlapMatrix(clusters) {
  const matrix = {};
  for (const cluster of clusters) {
    const sources = cluster.sources;
    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const key = pairKey(sources[i], sources[j]);
        matrix[key] = (matrix[key] ?? 0) + 1;
      }
    }
  }
  return Object.fromEntries(Object.entries(matrix).sort(([a], [b]) => a.localeCompare(b)));
}

function clusterToCsvRow(cluster) {
  const row = {
    parcel_id: cluster.parcel_id,
    source_count: cluster.source_count,
    sources: cluster.sources.join("; "),
    address: cluster.address,
    city: cluster.city,
    record_count: cluster.record_count,
  };
  for (const sourceId of Object.keys(SOURCE_LOADERS)) {
    const refs = cluster.records[sourceId] ?? [];
    row[`${sourceId}_count`] = refs.length;
    row[`${sourceId}_keys`] = refs.map((r) => r.source_key).filter(Boolean).join("; ");
    row[`${sourceId}_labels`] = refs.map((r) => r.label).filter(Boolean).join("; ");
  }
  return row;
}

export function buildAllClusters() {
  const byParcel = new Map();
  const unlinked = {};
  const sourceTotals = {};
  const sourceWithParcel = {};

  for (const [sourceId, loader] of Object.entries(SOURCE_LOADERS)) {
    const records = loader();
    sourceTotals[sourceId] = records.length;
    let withParcel = 0;

    for (const record of records) {
      const parcelId = normalizeParcelId(record.parcel_id);
      if (!parcelId) {
        unlinked[sourceId] = (unlinked[sourceId] ?? 0) + 1;
        continue;
      }
      withParcel++;

      if (!byParcel.has(parcelId)) {
        byParcel.set(parcelId, {});
      }
      const bucket = byParcel.get(parcelId);
      if (!bucket[sourceId]) bucket[sourceId] = [];
      bucket[sourceId].push(compactRecord(record, sourceId));
    }

    sourceWithParcel[sourceId] = withParcel;
  }

  const allClusters = [];
  for (const [parcelId, recordsBySource] of byParcel) {
    const sources = Object.keys(recordsBySource).sort();
    const recordCount = sources.reduce((n, s) => n + recordsBySource[s].length, 0);
    const addr = bestAddress(recordsBySource);
    allClusters.push({
      parcel_id: parcelId,
      source_count: sources.length,
      sources,
      record_count: recordCount,
      address: addr.address,
      city: addr.city,
      address_source: addr.from,
      records: recordsBySource,
    });
  }

  allClusters.sort((a, b) => b.source_count - a.source_count || b.record_count - a.record_count);

  return { allClusters, unlinked, sourceTotals, sourceWithParcel };
}

function main() {
  const { allClusters, unlinked, sourceTotals, sourceWithParcel } = buildAllClusters();

  const linkedClusters = allClusters.filter((c) => c.source_count >= 2);
  const overlapMatrix = buildOverlapMatrix(linkedClusters);

  const output = {
    generated_at: new Date().toISOString(),
    link_key: "parcel_id",
    stats: {
      distinct_parcels: allClusters.length,
      multi_source_parcels: linkedClusters.length,
      single_source_parcels: allClusters.length - linkedClusters.length,
      source_totals: sourceTotals,
      source_with_parcel_id: sourceWithParcel,
      source_without_parcel_id: unlinked,
      overlap_matrix: overlapMatrix,
    },
    clusters: linkedClusters,
  };

  fs.writeFileSync(LINKS_JSON, JSON.stringify(output, null, 2));
  fs.writeFileSync(LINKS_CSV, toCsv(linkedClusters.map(clusterToCsvRow)));
  fs.writeFileSync(
    INDEX_JSON,
    JSON.stringify(
      {
        generated_at: output.generated_at,
        parcel_count: allClusters.length,
        parcels: allClusters.map((c) => ({
          parcel_id: c.parcel_id,
          source_count: c.source_count,
          sources: c.sources,
          record_count: c.record_count,
          address: c.address,
        })),
      },
      null,
      2
    )
  );

  console.error("Lead linking complete (parcel_id hub)");
  console.error(`  Distinct parcels:      ${allClusters.length}`);
  console.error(`  Multi-source links:    ${linkedClusters.length}`);
  console.error(`  Single-source only:    ${allClusters.length - linkedClusters.length}`);
  console.error("");
  console.error("  Source coverage:");
  for (const [sourceId, total] of Object.entries(sourceTotals)) {
    const linked = sourceWithParcel[sourceId] ?? 0;
    const missing = unlinked[sourceId] ?? 0;
    console.error(`    ${sourceId}: ${linked}/${total} linked (${missing} missing parcel_id)`);
  }
  console.error("");
  console.error("  Pair overlaps:");
  for (const [pair, count] of Object.entries(overlapMatrix)) {
    console.error(`    ${pair}: ${count}`);
  }
  console.error("");
  console.error(`Wrote ${LINKS_JSON}`);
  console.error(`Wrote ${LINKS_CSV}`);
  console.error(`Wrote ${INDEX_JSON}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

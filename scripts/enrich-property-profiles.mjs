/**
 * Pull full Parcel_CAMA attributes for lead-list parcels.
 *
 * No server-side filtering — vacant land and all auditor values are included
 * so the UI can explain why a lead ranks low. Not for ARV or auto-offers.
 *
 * Prerequisites: npm run link:leads (reads lead-parcel-index.json)
 *
 * Usage:
 *   npm run enrich:property-profiles
 *   node scripts/enrich-property-profiles.mjs --limit 20
 *   node scripts/enrich-property-profiles.mjs --distress-only
 *   node scripts/enrich-property-profiles.mjs --force
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths } from "../src/core/county-context.mjs";
import { findLatestTaxLienJson } from "../src/core/tax-lien-discovery.mjs";
import {
  queryParcelCamaById,
  extractAuditorValues,
  derivePropertyHints,
} from "./auditor-cama.mjs";

const p = paths();
const INDEX_JSON = p.leadParcelIndex;
const TAX_LIEN_JSON =
  findLatestTaxLienJson(p.dataRoot)?.path ?? p.file("tax-lien-list-10-21-2025.json");
const CACHE_PATH = p.propertyProfileCache;
const PROFILES_JSON = p.propertyProfiles;
const PROFILES_BY_PARCEL_JSON = p.propertyProfilesByParcel;
const REPORT_JSON = path.join(p.dataRoot, "property-profiles-report.json");

const DISTRESS_SOURCES = new Set([
  "probate-estates",
  "evictions",
  "code-violations",
  "clerk-foreclosures",
  "sheriff-sales",
  "lis-pendens",
]);

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit");
  const delayIdx = process.argv.indexOf("--delay-ms");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;
  const delayMs = delayIdx >= 0 ? parseInt(process.argv[delayIdx + 1], 10) : 200;
  return {
    force: process.argv.includes("--force"),
    distressOnly: process.argv.includes("--distress-only"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 200,
  };
}

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

function loadLeadParcels({ distressOnly = false } = {}) {
  if (!fs.existsSync(INDEX_JSON)) {
    throw new Error(`Missing ${INDEX_JSON}. Run: npm run link:leads`);
  }
  const index = JSON.parse(fs.readFileSync(INDEX_JSON, "utf8"));
  let parcels = index.parcels ?? [];
  if (distressOnly) {
    parcels = parcels.filter((p) => {
      const sources = p.sources ?? [];
      if (sources.length === 0) return false;
      if (sources.length === 1 && sources[0] === "tax-liens") return false;
      return sources.some((s) => DISTRESS_SOURCES.has(s));
    });
  }
  return parcels;
}

function loadTaxLienByParcel() {
  const map = new Map();
  if (!fs.existsSync(TAX_LIEN_JSON)) return map;

  const raw = JSON.parse(fs.readFileSync(TAX_LIEN_JSON, "utf8"));
  for (const district of raw.districts ?? []) {
    for (const parcel of district.parcels ?? []) {
      if (!parcel.parcel_id) continue;
      map.set(parcel.parcel_id, {
        parcel_id: parcel.parcel_id,
        district_code: district.code ?? null,
        district_name: district.name ?? null,
        owner_name: parcel.owner_name ?? null,
        street_address: parcel.street_address ?? null,
        city: parcel.city ?? null,
        state: parcel.state ?? null,
        zip: parcel.zip ?? null,
        legal_description: parcel.legal_description ?? null,
        acres: parcel.acres ?? null,
        prior_delq: parcel.prior_delq ?? null,
        land_value: parcel.land_value ?? null,
        building_value: parcel.building_value ?? null,
        total_value: parcel.total_value ?? null,
        cert_status: parcel.cert_status ?? null,
        delinquent_year: parcel.delinquent_year ?? null,
        payment_plan: parcel.payment_plan ?? null,
      });
    }
  }
  return map;
}

function buildProfile(lead, fetchResult, taxLien) {
  const camaRaw = fetchResult.cama_raw ?? null;
  const camaAuditor = extractAuditorValues(camaRaw);
  const taxLienAuditor = taxLien
    ? {
        land_value: taxLien.land_value ?? null,
        building_value: taxLien.building_value ?? null,
        total_value: taxLien.total_value ?? null,
        acres: taxLien.acres ?? null,
        prior_delq: taxLien.prior_delq ?? null,
        delinquent_year: taxLien.delinquent_year ?? null,
        cert_status: taxLien.cert_status ?? null,
      }
    : null;

  return {
    parcel_id: lead.parcel_id,
    lead: {
      source_count: lead.source_count ?? null,
      sources: lead.sources ?? [],
      record_count: lead.record_count ?? null,
      address: lead.address ?? null,
    },
    fetch_status: fetchResult.status,
    fetched_at: fetchResult.fetched_at,
    error: fetchResult.error ?? null,
    cama_raw: camaRaw,
    auditor_values: {
      from_cama: camaAuditor,
      from_tax_lien: taxLienAuditor,
    },
    tax_lien: taxLien,
    hints: derivePropertyHints({ camaRaw, camaAuditor, taxLien: taxLienAuditor }),
  };
}

function summarizeProfiles(profiles) {
  const stats = {
    total: profiles.length,
    ok: 0,
    not_found: 0,
    error: 0,
    likely_vacant_land: 0,
    has_improvements: 0,
    with_tax_lien: 0,
    multi_source: 0,
  };

  for (const profile of profiles) {
    if (profile.fetch_status === "ok") stats.ok++;
    else if (profile.fetch_status === "not_found") stats.not_found++;
    else if (profile.fetch_status === "error") stats.error++;

    if (profile.hints?.likely_vacant_land) stats.likely_vacant_land++;
    if (profile.hints?.has_improvements) stats.has_improvements++;
    if (profile.tax_lien) stats.with_tax_lien++;
    if ((profile.lead?.source_count ?? 0) >= 2) stats.multi_source++;
  }

  return stats;
}

async function main() {
  const args = parseArgs();
  const cache = loadDiskCache();
  const taxLienByParcel = loadTaxLienByParcel();
  let leads = loadLeadParcels({ distressOnly: args.distressOnly });

  if (args.limit) leads = leads.slice(0, args.limit);

  console.error("Property profile enrichment");
  console.error(`  Parcels to process: ${leads.length}`);
  console.error(`  Distress-only:      ${args.distressOnly}`);
  console.error(`  Force re-fetch:     ${args.force}`);
  console.error(`  Delay (ms):         ${args.delayMs}`);
  console.error("");

  const profiles = [];
  const errors = [];
  let processed = 0;
  let fetched = 0;
  let cacheHits = 0;

  for (const lead of leads) {
    processed++;
    const cacheKey = `cama:${lead.parcel_id}`;
    const hadCache = !args.force && cache.has(cacheKey);

    const fetchResult = await queryParcelCamaById(lead.parcel_id, cache, {
      force: args.force,
      delayMs: hadCache ? 0 : args.delayMs,
    });

    if (hadCache) cacheHits++;
    else fetched++;

    const taxLien = taxLienByParcel.get(lead.parcel_id) ?? null;
    const profile = buildProfile(lead, fetchResult, taxLien);
    profiles.push(profile);

    if (fetchResult.status === "error") {
      errors.push({
        parcel_id: lead.parcel_id,
        error: fetchResult.error,
      });
    }

    if (processed === 1 || processed % 10 === 0 || processed === leads.length) {
      saveDiskCache(cache);
      console.error(
        `  ${processed}/${leads.length} ${lead.parcel_id} ${fetchResult.status}${hadCache ? " (cached)" : ""}`
      );
    }
  }

  saveDiskCache(cache);

  const stats = summarizeProfiles(profiles);
  const generatedAt = new Date().toISOString();

  const byParcel = Object.fromEntries(profiles.map((p) => [p.parcel_id, p]));

  fs.writeFileSync(
    PROFILES_JSON,
    JSON.stringify(
      {
        generated_at: generatedAt,
        stats,
        profiles,
      },
      null,
      2
    )
  );

  fs.writeFileSync(PROFILES_BY_PARCEL_JSON, JSON.stringify(byParcel, null, 2));

  fs.writeFileSync(
    REPORT_JSON,
    JSON.stringify(
      {
        generated_at: generatedAt,
        options: args,
        stats: {
          ...stats,
          processed,
          fetched,
          cache_hits: cacheHits,
        },
        errors: errors.slice(0, 100),
      },
      null,
      2
    )
  );

  console.error("");
  console.error("Property profile enrichment complete");
  console.error(`  OK:                 ${stats.ok}`);
  console.error(`  Not found:          ${stats.not_found}`);
  console.error(`  Errors:             ${stats.error}`);
  console.error(`  Likely vacant land: ${stats.likely_vacant_land}`);
  console.error(`  Has improvements:   ${stats.has_improvements}`);
  console.error(`  With tax lien row:  ${stats.with_tax_lien}`);
  console.error(`  Multi-source leads: ${stats.multi_source}`);
  console.error(`  API fetches:        ${fetched} (${cacheHits} cache hits)`);
  console.error("");
  console.error(`Wrote ${PROFILES_JSON}`);
  console.error(`Wrote ${PROFILES_BY_PARCEL_JSON}`);
  console.error(`Wrote ${REPORT_JSON}`);
  console.error(`Wrote ${CACHE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

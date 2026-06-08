/**
 * Enrich clerk foreclosure records with property address + parcel_id.
 *
 * Strategy per case:
 *   1. Open case detail page (case number search)
 *   2. Parcel/address from detail HTML when present
 *   3. GIS address lookup
 *   4. Tax lien list owner match (tax foreclosures)
 *   5. GIS owner-name lookup on defendant
 *
 * Usage:
 *   npm run enrich:clerk-foreclosures
 *   node scripts/enrich-clerk-foreclosures.mjs --limit 5
 *   node scripts/enrich-clerk-foreclosures.mjs --no-details   # skip browser, name/lien only
 *   node scripts/enrich-clerk-foreclosures.mjs --force
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  loadAllMonthRecords,
  writeCanonicalFromMonths,
  toCsv,
} from "./scrape-state.mjs";
import { ensureClerkSession, BASE_URL } from "./clerk-session.mjs";
import {
  openClerkCaseDetail,
  mergeClerkDetail,
  needsClerkEnrichment,
} from "./clerk-detail.mjs";
import { paths } from "../src/core/county-context.mjs";
import {
  lookupParcelByAddress,
  lookupParcelByOwnerName,
  lookupParcelById,
  applyParcelLookup,
} from "./auditor-gis.mjs";
import { findTaxLienByOwnerName, loadTaxLienParcels } from "./tax-lien-index.mjs";
import { clean, isGarbagePartyName } from "./name-match.mjs";

function effectiveDefendant(record) {
  const style = clean(record.case_style);
  const fromStyle = style.match(/\bv\s+(.+)$/i)?.[1];
  if (fromStyle && !isGarbagePartyName(fromStyle)) return clean(fromStyle);

  const direct = clean(record.defendant);
  if (direct && !isGarbagePartyName(direct) && !/treasurer|county/i.test(direct)) {
    return direct;
  }

  return direct || null;
}

const p = paths();
const DATA_DIR = p.dataRoot;
const SOURCE_ID = "clerk-foreclosures";
const REPORT_PATH = p.file("clerk-enrichment-report.json");
const CACHE_PATH = p.file("parcel-lookup-cache.json");

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;
  return {
    force: process.argv.includes("--force"),
    details: !process.argv.includes("--no-details"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    headed: process.argv.includes("--headed") || process.argv.includes("--interactive"),
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

function applyTaxLienMatch(record, match) {
  return {
    ...record,
    parcel_id: match.parcel_id,
    property_address: record.property_address ?? match.property_address ?? null,
    city: record.city ?? match.city ?? null,
    state: record.state ?? match.state ?? "OH",
    zip: record.zip ?? match.zip ?? null,
    auditor_owner_name: match.owner_name ?? null,
    parcel_lookup: "matched",
    parcel_match_source: "tax_lien_list",
    parcel_match_score: match.match_score ?? null,
  };
}

function applyOwnerLookup(record, lookup, source) {
  if (lookup.status === "matched" && lookup.match) {
    return {
      ...record,
      parcel_id: lookup.match.parcel_id,
      property_address: record.property_address ?? lookup.match.parcel_address ?? null,
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

async function resolveParcel(record, cache, taxParcels, report) {
  let current = { ...record };

  if (current.parcel_id) {
    const byId = await lookupParcelById(current.parcel_id, cache);
    if (byId.status === "matched" && byId.match) {
      current.property_address = current.property_address ?? byId.match.parcel_address ?? null;
      current.auditor_parcel_address = byId.match.parcel_address ?? null;
      current.auditor_owner_name = byId.match.owner_name ?? null;
      current.parcel_lookup = "matched";
      current.parcel_match_source = "case_detail_parcel";
      return current;
    }
  }

  const street = current.property_address ?? current.street_address ?? null;
  if (street) {
    const byAddress = await lookupParcelByAddress(street, cache, { delayMs: 50 });
    current = applyParcelLookup(current, byAddress);
    if (byAddress.status === "matched") {
      current.parcel_match_source = "gis_address";
      return current;
    }
    if (byAddress.status === "ambiguous") {
      current.parcel_match_source = "gis_address";
      report.unmatched.push({
        case_number: current.case_number,
        method: "gis_address",
        defendant: current.defendant,
        address: street,
        status: "ambiguous",
        candidates: byAddress.candidates,
      });
      return current;
    }
  }

  const defendant = effectiveDefendant(current);
  if (defendant && !isGarbagePartyName(defendant)) {
    if (/tax\s*foreclos/i.test(current.case_description ?? "")) {
      const taxMatch = findTaxLienByOwnerName(defendant, taxParcels);
      if (taxMatch.status === "matched") {
        return applyTaxLienMatch(current, taxMatch.match);
      }
      if (taxMatch.status === "ambiguous") {
        report.unmatched.push({
          case_number: current.case_number,
          method: "tax_lien_list",
          defendant,
          status: "ambiguous",
          candidates: taxMatch.candidates,
        });
      }
    }

    const byOwner = await lookupParcelByOwnerName(defendant, cache, { delayMs: 50 });
    current = applyOwnerLookup(current, byOwner, "gis_owner");
    if (byOwner.status !== "not_found") return current;
  }

  if (!current.parcel_lookup) current.parcel_lookup = "not_found";
  report.unmatched.push({
    case_number: current.case_number,
    method: "all",
    defendant: current.defendant ?? null,
    address: street,
    status: current.parcel_lookup,
  });
  return current;
}

function rewriteMonthFiles(enrichedByKey) {
  const prefix = `${SOURCE_ID}-month-`;
  for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))) {
    const filePath = path.join(DATA_DIR, file);
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const updated = rows.map((row) => enrichedByKey.get(row.case_number) ?? row);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    fs.writeFileSync(filePath.replace(/\.json$/, ".csv"), toCsv(updated));
  }
}

async function enrichClerkForeclosures(options) {
  const records = loadAllMonthRecords(SOURCE_ID, (r) => r.case_number);
  let todo = records.filter((r) => needsClerkEnrichment(r, { force: options.force }));
  if (options.limit) todo = todo.slice(0, options.limit);

  const cache = loadDiskCache();
  const taxParcels = loadTaxLienParcels();
  const report = {
    generated_at: new Date().toISOString(),
    total: records.length,
    attempted: todo.length,
    stats: { detail_ok: 0, with_address: 0, with_parcel: 0, matched: 0, not_found: 0, ambiguous: 0 },
    unmatched: [],
    errors: [],
  };

  console.error(`Clerk foreclosure enrichment: ${todo.length} case(s) to process`);
  console.error(`Tax lien index: ${taxParcels.length} parcels`);

  const enrichedByKey = new Map(records.map((r) => [r.case_number, r]));
  let browser = null;
  let page = null;

  if (options.details) {
    browser = await chromium.launch({
      headless: !options.headed,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext();
    page = await context.newPage();
    await ensureClerkSession(page, context, {
      interactive: options.headed,
      ocrAttempts: options.headed ? 8 : 0,
    });
  }

  try {
    for (let i = 0; i < todo.length; i++) {
      const record = todo[i];
      const label = `${i + 1}/${todo.length} ${record.case_number}`;
      let working = { ...record };

      try {
        if (page) {
          const opened = await openClerkCaseDetail(page, record.case_number);
          working = mergeClerkDetail(working, opened.detail);
          report.stats.detail_ok++;
          if (working.property_address) report.stats.with_address++;
        }

        working = await resolveParcel(working, cache, taxParcels, report);
        if (working.parcel_id) {
          report.stats.with_parcel++;
          report.stats.matched++;
          console.error(`  ${label} → ${working.parcel_id} (${working.parcel_match_source ?? working.parcel_lookup})`);
        } else {
          report.stats.not_found++;
          console.error(`  ${label} → no parcel (${working.parcel_lookup ?? "not_found"})`);
        }

        if (working.parcel_lookup === "ambiguous") report.stats.ambiguous++;

        enrichedByKey.set(record.case_number, working);
      } catch (err) {
        report.errors.push({ case_number: record.case_number, error: err.message });
        console.error(`  ${label} → error: ${err.message}`);

        try {
          working = await resolveParcel(working, cache, taxParcels, report);
          enrichedByKey.set(record.case_number, working);
        } catch (fallbackErr) {
          console.error(`  ${label} → fallback failed: ${fallbackErr.message}`);
        }
      }

      if ((i + 1) % 10 === 0) saveDiskCache(cache);
    }
  } finally {
    if (browser) await browser.close();
  }

  saveDiskCache(cache);

  rewriteMonthFiles(enrichedByKey);
  const { canonical, canonicalJson, canonicalCsv } = writeCanonicalFromMonths(SOURCE_ID, (r) => r.case_number);

  report.stats.with_parcel = canonical.filter((r) => r.parcel_id).length;
  report.stats.with_address = canonical.filter((r) => r.property_address).length;
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.error(`\nWith parcel_id: ${report.stats.with_parcel}/${canonical.length}`);
  console.error(`With address:    ${report.stats.with_address}/${canonical.length}`);
  console.error(`Wrote ${canonicalJson}`);
  console.error(`Wrote ${canonicalCsv}`);
  console.error(`Wrote ${REPORT_PATH}`);
}

const options = parseArgs();
enrichClerkForeclosures(options).catch((err) => {
  console.error(err);
  process.exit(1);
});

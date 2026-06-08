/**
 * @county richland — Merge GIS comp-index with auditor CAMA Update .DAT overlay.
 *
 * Usage: npm run import:auditor-cama
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths, getActiveCounty } from "../src/core/county-context.mjs";
import {
  CAMA_DIR,
  loadAsmtIndex,
  loadChargeIndex,
  loadDwellIndexSync,
  loadLatestValidSales,
  loadOwndatmaxIndex,
  loadPardatIndex,
} from "./auditor-cama-dat.mjs";
import { buildSalesEvents } from "./build-sales-events.mjs";

const p = paths();
const COMP_INDEX = p.compIndex;
const COMP_INDEX_AUDITOR = p.compIndexAuditor;
const OVERLAY_JSON = p.parcelOverlay;
const MANIFEST_JSON = p.importManifest;
const SALES_EVENTS = p.salesEvents;

function loadCompIndexDeduped() {
  if (!fs.existsSync(COMP_INDEX)) {
    throw new Error(`Missing ${COMP_INDEX}. Run: npm run pull:county-parcels`);
  }
  const map = new Map();
  let dupes = 0;
  for (const line of fs.readFileSync(COMP_INDEX, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (!rec.parcel_id) continue;
    if (map.has(rec.parcel_id)) dupes++;
    map.set(rec.parcel_id, rec);
  }
  return { map, dupes };
}

function mergeRecord(gis, owners, asmt, sales, pardat, dwell, charge) {
  const auditorOwner = owners.get(gis.parcel_id) ?? null;
  const auditorAsmt = asmt.get(gis.parcel_id) ?? null;
  const auditorSale = sales.get(gis.parcel_id) ?? null;
  const auditorAddr = pardat.get(gis.parcel_id) ?? null;
  const auditorDwell = dwell?.get(gis.parcel_id) ?? null;
  const auditorCharge = charge?.get(gis.parcel_id) ?? null;

  const gisOwner = gis.owner_name ?? null;
  const auditorOwnerName = auditorOwner?.owner_name ?? null;
  const ownerDiffers =
    gisOwner &&
    auditorOwnerName &&
    gisOwner.replace(/\s+/g, " ").trim().toUpperCase() !==
      auditorOwnerName.replace(/\s+/g, " ").trim().toUpperCase();

  const square_footage = auditorDwell?.square_footage ?? gis.square_footage ?? null;
  const bedrooms = auditorDwell?.bedrooms ?? gis.bedrooms ?? null;
  const full_bath = auditorDwell?.full_bath ?? gis.full_bath ?? null;
  const half_bath = auditorDwell?.half_bath ?? gis.half_bath ?? null;
  const year_built = auditorDwell?.year_built ?? gis.year_built ?? null;
  const style = auditorDwell?.style ?? gis.style ?? null;
  const grade = auditorDwell?.grade ?? gis.grade ?? null;
  const condition = auditorDwell?.condition ?? gis.condition ?? null;
  const stories = auditorDwell?.stories ?? gis.stories ?? null;

  return {
    ...gis,
    address: auditorAddr?.address ?? gis.address,
    square_footage,
    bedrooms,
    full_bath,
    half_bath,
    year_built,
    style,
    grade,
    condition,
    condition_source: auditorDwell?.condition ? "dwelling_dat" : gis.condition ? "gis" : null,
    stories,
    year_remodeled: auditorDwell?.year_remodeled ?? gis.year_remodeled ?? null,
    rooms: auditorDwell?.rooms ?? gis.rooms ?? null,
    auditor_dwell_card: auditorDwell?.dwell_card ?? null,
    auditor_dwell_tax_year: auditorDwell?.dwell_tax_year ?? null,
    building_attributes_source: auditorDwell ? "dwelling_dat" : gis.bedrooms != null ? "gis" : null,
    owner_name: auditorOwnerName ?? gis.owner_name,
    gis_owner_name: gisOwner,
    auditor_owner_name: auditorOwnerName,
    auditor_owner_tax_year: auditorOwner?.tax_year ?? null,
    auditor_mailing_address: auditorOwner?.mailing_address ?? null,
    auditor_mailing_street: auditorOwner?.mailing_street ?? null,
    auditor_mailing_city: auditorOwner?.mailing_city ?? null,
    auditor_mailing_state: auditorOwner?.mailing_state ?? null,
    auditor_mailing_zip: auditorOwner?.mailing_zip ?? null,
    gis_owner_stale: ownerDiffers,
    land_value: auditorAsmt?.land_value ?? gis.land_value,
    building_value: auditorAsmt?.building_value ?? gis.building_value,
    total_appraised_value: auditorAsmt?.total_appraised_value ?? gis.total_appraised_value,
    auditor_land_value: auditorAsmt?.land_value ?? null,
    auditor_building_value: auditorAsmt?.building_value ?? null,
    auditor_total_appraised_value: auditorAsmt?.total_appraised_value ?? null,
    auditor_assessment_tax_year: auditorAsmt?.assessment_tax_year ?? null,
    sale_date: auditorSale?.sale_date ?? gis.sale_date,
    sale_price: auditorSale?.sale_price ?? gis.sale_price,
    auditor_sale_date: auditorSale?.sale_date ?? null,
    auditor_sale_price: auditorSale?.sale_price ?? null,
    auditor_sale_validity_code: auditorSale?.validity_code ?? null,
    auditor_sale_grantor: auditorSale?.grantor ?? null,
    auditor_sale_grantee: auditorSale?.grantee ?? null,
    gis_sale_date: gis.sale_date,
    gis_sale_price: gis.sale_price,
    owner_source: auditorOwnerName ? "auditor_cama" : "gis",
    sale_source: auditorSale ? "auditor_cama" : "gis",
    charge_tax_year: auditorCharge?.tax_year ?? null,
    prior_delinquent: auditorCharge?.prior_delinquent ?? null,
    net_delinquency_due: auditorCharge?.net_delinquency_due ?? null,
    charge_delinquent: auditorCharge?.is_delinquent ?? false,
    charge_maintenance_date: auditorCharge?.maintenance_date ?? null,
    delinquency_source: auditorCharge?.prior_delinquent != null ? "charge_dat" : null,
    overlay_at: new Date().toISOString(),
  };
}

function main() {
  console.error("Loading auditor .DAT indexes...");
  const owners = loadOwndatmaxIndex();
  const asmt = loadAsmtIndex();
  const sales = loadLatestValidSales();
  const pardat = loadPardatIndex();
  const dwell = loadDwellIndexSync();
  const charge = loadChargeIndex();

  console.error(`  OWNDATMAX owners: ${owners.size}`);
  console.error(`  ASMT values:      ${asmt.size}`);
  console.error(`  valid sales:      ${sales.size}`);
  console.error(`  PARDAT addresses: ${pardat.size}`);
  console.error(`  DWELL buildings:  ${dwell.size}`);
  console.error(`  CHARGE billing:   ${charge.size}`);

  const { map: gisMap, dupes } = loadCompIndexDeduped();
  console.error(`  GIS comp-index:   ${gisMap.size} unique (${dupes} dupes dropped)`);

  const merged = [];
  let ownerOverlay = 0;
  let saleOverlay = 0;
  let staleOwners = 0;
  let dwellOverlay = 0;
  let chargeOverlay = 0;
  let delinquentParcels = 0;

  for (const gis of gisMap.values()) {
    const rec = mergeRecord(gis, owners, asmt, sales, pardat, dwell, charge);
    if (rec.auditor_owner_name) ownerOverlay++;
    if (rec.auditor_sale_date) saleOverlay++;
    if (rec.gis_owner_stale) staleOwners++;
    if (rec.building_attributes_source === "dwelling_dat") dwellOverlay++;
    if (rec.prior_delinquent != null) chargeOverlay++;
    if (rec.charge_delinquent) delinquentParcels++;
    merged.push(rec);
  }

  fs.mkdirSync(path.dirname(COMP_INDEX_AUDITOR), { recursive: true });
  fs.writeFileSync(COMP_INDEX_AUDITOR, `${merged.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const overlay = {};
  for (const rec of merged) {
    if (!rec.auditor_owner_name && !rec.auditor_sale_date) continue;
    overlay[rec.parcel_id] = {
      owner_name: rec.auditor_owner_name,
      owner_tax_year: rec.auditor_owner_tax_year,
      mailing_address: rec.auditor_mailing_address,
      mailing_street: rec.auditor_mailing_street,
      mailing_city: rec.auditor_mailing_city,
      mailing_state: rec.auditor_mailing_state,
      mailing_zip: rec.auditor_mailing_zip,
      sale_date: rec.auditor_sale_date,
      sale_price: rec.auditor_sale_price,
      sale_grantor: rec.auditor_sale_grantor,
      sale_grantee: rec.auditor_sale_grantee,
      land_value: rec.auditor_land_value,
      building_value: rec.auditor_building_value,
      total_appraised_value: rec.auditor_total_appraised_value,
      gis_owner_stale: rec.gis_owner_stale,
      prior_delinquent: rec.prior_delinquent,
      net_delinquency_due: rec.net_delinquency_due,
      charge_delinquent: rec.charge_delinquent,
    };
  }
  fs.writeFileSync(OVERLAY_JSON, JSON.stringify(overlay, null, 2));

  const parcelIndex = new Map(merged.map((r) => [r.parcel_id, r]));
  console.error("Building county-wide sales events...");
  const { events, stats: salesStats } = buildSalesEvents({ parcelIndex });
  fs.writeFileSync(SALES_EVENTS, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

  const asmtYears = {};
  for (const rec of asmt.values()) {
    if (rec.assessment_tax_year) {
      asmtYears[rec.assessment_tax_year] = (asmtYears[rec.assessment_tax_year] ?? 0) + 1;
    }
  }
  const ownerYears = {};
  for (const rec of owners.values()) {
    if (rec.tax_year) ownerYears[rec.tax_year] = (ownerYears[rec.tax_year] ?? 0) + 1;
  }

  const manifest = {
    county_id: getActiveCounty(),
    generated_at: new Date().toISOString(),
    source_dir: CAMA_DIR,
    data_vintage: {
      county_note:
        "Regional and Charge tabs reflect 2025 assessment data until Real Estate completes 2026 calculations.",
      regional_tab: "Google Drive Regional folder — ASMT, DWELL, SALES, PARDAT, etc.",
      charge_tab: "Google Drive Charge folder — CHARGE.DAT (tax billing); also 2025 until reval done.",
      layout_docs: [
        "AA407_layout_2021_1 (Regional tab) — field map for .DAT files",
        "Charge_Layout 2021 (Charge tab) — field map for CHARGE.DAT",
      ],
      assessment_tax_years_in_asmt: asmtYears,
      owner_tax_years_in_owndatmax: ownerYears,
      trust_for_wholesaling: {
        owners: "Use OWNDATMAX / auditor overlay (can be 2026 tax year)",
        sales: "Use SALES.DAT (transaction-dated; current through export)",
        assessed_values: "ASMT is 2025 until county updates Regional export",
        beds_baths_sqft: "DWELL.DAT (auditor) preferred over GIS Parcel_CAMA",
      },
    },
    gis_unique_parcels: gisMap.size,
    gis_duplicates_dropped: dupes,
    merged_parcels: merged.length,
    auditor_owner_overlay: ownerOverlay,
    auditor_sale_overlay: saleOverlay,
    auditor_dwell_overlay: dwellOverlay,
    auditor_charge_overlay: chargeOverlay,
    charge_delinquent_parcels: delinquentParcels,
    gis_owner_stale: staleOwners,
    outputs: {
      comp_index_auditor: COMP_INDEX_AUDITOR,
      parcel_overlay: OVERLAY_JSON,
      sales_events: SALES_EVENTS,
    },
    sales_events: salesStats,
  };
  fs.writeFileSync(MANIFEST_JSON, JSON.stringify(manifest, null, 2));

  console.error("");
  console.error("Auditor CAMA import complete");
  console.error(`  Merged parcels:        ${merged.length}`);
  console.error(`  Owner overlay:         ${ownerOverlay}`);
  console.error(`  Sale overlay:          ${saleOverlay}`);
  console.error(`  GIS owner stale:       ${staleOwners}`);
  console.error(`  DWELL overlay:         ${dwellOverlay}`);
  console.error(`  CHARGE delinq overlay: ${chargeOverlay} (${delinquentParcels} flagged delinquent)`);
  console.error(`  Sales events:          ${salesStats.joined_with_parcel} (${salesStats.with_coordinates} with coords)`);
  console.error(`  Wrote ${COMP_INDEX_AUDITOR}`);
  console.error(`  Wrote ${OVERLAY_JSON}`);
  console.error(`  Wrote ${SALES_EVENTS}`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

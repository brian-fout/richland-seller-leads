/**
 * @county richland — Build county-wide sales events from SALES.DAT joined to comp-index parcels.
 *
 * Each line = one valid arm's-length sale with parcel location/attributes.
 * Used as the ARV comp pool (all parcels, not just distress leads).
 *
 * Usage: npm run build:sales-events
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths } from "../src/core/county-context.mjs";
import { CAMA_DIR, parseSalesLine } from "./auditor-cama-dat.mjs";

const p = paths();
const COMP_INDEX_AUDITOR = p.compIndexAuditor;
const COMP_INDEX = p.compIndex;
const SALES_EVENTS = p.salesEvents;
const MANIFEST = p.salesEventsManifest;

function loadParcelIndex() {
  const file = fs.existsSync(COMP_INDEX_AUDITOR) ? COMP_INDEX_AUDITOR : COMP_INDEX;
  if (!fs.existsSync(file)) {
    throw new Error(`Missing comp index. Run: npm run pull:county-parcels && npm run import:auditor-cama`);
  }
  const map = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.parcel_id) map.set(rec.parcel_id, rec);
  }
  return map;
}

function buildSaleEvent(sale, parcel) {
  return {
    event_id: `${sale.parcel_id}:${sale.sale_key ?? sale.sale_date}:${sale.sale_price}`,
    parcel_id: sale.parcel_id,
    sale_date: sale.sale_date,
    sale_price: sale.sale_price,
    validity_code: sale.validity_code,
    sale_type_code: sale.sale_type_code,
    sale_key: sale.sale_key,
    grantor: sale.grantor,
    grantee: sale.grantee,
    address: parcel.address ?? null,
    city: parcel.city ?? null,
    lat: parcel.lat ?? null,
    lon: parcel.lon ?? null,
    land_use_code: parcel.land_use_code ?? null,
    neighborhood: parcel.neighborhood ?? null,
    municipality: parcel.municipality ?? null,
    square_footage: parcel.square_footage ?? null,
    year_built: parcel.year_built ?? null,
    bedrooms: parcel.bedrooms ?? null,
    full_bath: parcel.full_bath ?? null,
    half_bath: parcel.half_bath ?? null,
    style: parcel.style ?? null,
    stories: parcel.stories ?? null,
    condition: parcel.condition ?? null,
    grade: parcel.grade ?? null,
    has_improvements: parcel.has_improvements ?? false,
    likely_vacant_land: parcel.likely_vacant_land ?? false,
    land_value: parcel.auditor_land_value ?? parcel.land_value ?? null,
    building_value: parcel.auditor_building_value ?? parcel.building_value ?? null,
  };
}

export function buildSalesEvents({ parcelIndex, salesPath = path.join(CAMA_DIR, "SALES.DAT") } = {}) {
  if (!fs.existsSync(salesPath)) {
    throw new Error(`Missing ${salesPath}. Run: npm run download:auditor-cama`);
  }
  const parcels = parcelIndex ?? loadParcelIndex();
  const events = [];
  const stats = {
    sale_rows: 0,
    valid_sales: 0,
    joined_with_parcel: 0,
    with_coordinates: 0,
    missing_parcel: 0,
    rejected_date: 0,
    by_year: {},
  };

  for (const line of fs.readFileSync(salesPath, "latin1").split("\n")) {
    if (!/^\d{13}/.test(line)) continue;
    stats.sale_rows++;
    const sale = parseSalesLine(line);
    if (!sale) continue;
    if (!sale.sale_date) {
      stats.rejected_date++;
      continue;
    }
    if (!sale.is_valid_sale) continue;
    stats.valid_sales++;

    const year = sale.sale_date.slice(0, 4);
    stats.by_year[year] = (stats.by_year[year] ?? 0) + 1;

    const parcel = parcels.get(sale.parcel_id);
    if (!parcel) {
      stats.missing_parcel++;
      continue;
    }
    stats.joined_with_parcel++;

    const event = buildSaleEvent(sale, parcel);
    if (event.lat != null && event.lon != null) stats.with_coordinates++;
    events.push(event);
  }

  events.sort((a, b) => b.sale_date.localeCompare(a.sale_date) || a.parcel_id.localeCompare(b.parcel_id));
  return { events, stats, parcel_count: parcels.size };
}

function main() {
  console.error("Building county-wide sales events...");
  const { events, stats, parcel_count } = buildSalesEvents();

  fs.mkdirSync(path.dirname(SALES_EVENTS), { recursive: true });
  fs.writeFileSync(SALES_EVENTS, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

  const manifest = {
    generated_at: new Date().toISOString(),
    source: path.join(CAMA_DIR, "SALES.DAT"),
    parcel_index_size: parcel_count,
    ...stats,
    output: SALES_EVENTS,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  console.error(`  Parcel index:        ${parcel_count}`);
  console.error(`  SALES.DAT rows:      ${stats.sale_rows}`);
  console.error(`  Valid sales:         ${stats.valid_sales}`);
  console.error(`  Joined to parcel:    ${stats.joined_with_parcel}`);
  console.error(`  With coordinates:    ${stats.with_coordinates}`);
  console.error(`  Missing parcel:      ${stats.missing_parcel}`);
  console.error(`  Rejected bad dates:  ${stats.rejected_date}`);
  console.error(`  Wrote ${SALES_EVENTS}`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

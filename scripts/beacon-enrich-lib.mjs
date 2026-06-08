/**
 * Beacon cache + merge into county comp index.
 */

import fs from "fs";
import path from "path";
import { paths } from "../src/core/county-context.mjs";
import { loadBeaconSession, saveBeaconSession, parseBeaconDetailHtml } from "./beacon-parcel.mjs";

export { createBeaconBrowser, fetchBeaconParcel, saveBeaconSession, loadBeaconSession } from "./beacon-parcel.mjs";

const p = paths();
export const BEACON_CACHE_PATH = p.beaconParcelCache;
export const COMP_INDEX_PATH = p.compIndex;
export const COMP_INDEX_BEACON_PATH = path.join(p.countyParcels, "comp-index-beacon.jsonl");

export function loadBeaconCache() {
  const cache = new Map();
  if (!fs.existsSync(BEACON_CACHE_PATH)) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(BEACON_CACHE_PATH, "utf8"));
    for (const [key, value] of Object.entries(raw)) cache.set(key, value);
  } catch {
    // ignore
  }
  return cache;
}

export function saveBeaconCache(cache) {
  fs.writeFileSync(BEACON_CACHE_PATH, JSON.stringify(Object.fromEntries(cache.entries()), null, 2));
}

function pickLatestValidSale(sales = []) {
  for (const sale of sales) {
    if (!sale?.date) continue;
    if (/valid sale/i.test(sale.validity ?? "")) return sale;
  }
  return sales[0] ?? null;
}

export function beaconOverlayForComp(beacon) {
  if (!beacon || beacon.status !== "ok") return null;
  return {
    owner_name: beacon.owner_name ?? null,
    owner_source: "beacon",
    owner_fetched_at: beacon.fetched_at ?? null,
    parcel_address: beacon.parcel_address ?? null,
    city: beacon.city ?? null,
    zip: beacon.zip ?? null,
    land_value: beacon.land_value ?? null,
    building_value: beacon.building_value ?? null,
    total_value: beacon.total_value ?? null,
    market_value: beacon.market_value ?? null,
    year_built: beacon.year_built ?? null,
    square_footage: beacon.square_footage ?? null,
    bedrooms: beacon.bedrooms ?? null,
    full_bath: beacon.full_bath ?? null,
    land_use: beacon.land_use ?? null,
    beacon_sales: beacon.sales ?? [],
    beacon_fields: beacon.fields ?? {},
    beacon_source_url: beacon.source_url ?? null,
    gis_owner_stale:
      beacon.owner_name != null &&
      beacon.gis_owner_name != null &&
      beacon.owner_name.toUpperCase() !== beacon.gis_owner_name.toUpperCase(),
  };
}

export function mergeCompWithBeacon(comp, beacon) {
  const overlay = beaconOverlayForComp(beacon);
  if (!overlay) return { ...comp, owner_source: comp.owner_source ?? "gis" };

  const latestSale = pickLatestValidSale(beacon.sales);
  const merged = {
    ...comp,
    ...overlay,
    owner_name: overlay.owner_name ?? comp.owner_name,
    parcel_address: overlay.parcel_address ?? comp.address,
    address: overlay.parcel_address ?? comp.address,
    city: overlay.city ?? comp.city,
    zip: overlay.zip ?? comp.zip,
    land_value: overlay.land_value ?? comp.land_value,
    building_value: overlay.building_value ?? comp.building_value,
    total_appraised_value: overlay.total_value ?? comp.total_appraised_value,
    market_value: overlay.market_value ?? comp.market_value,
    year_built: overlay.year_built ?? comp.year_built,
    square_footage: overlay.square_footage ?? comp.square_footage,
    bedrooms: overlay.bedrooms ?? comp.bedrooms,
    full_bath: overlay.full_bath ?? comp.full_bath,
    sale_date: latestSale?.date ?? comp.sale_date,
    sale_price: latestSale?.price ?? comp.sale_price,
    sale_instrument: latestSale?.instrument ?? comp.sale_instrument,
    sale_old_owner: latestSale?.grantor ?? comp.sale_old_owner,
    sale_owner_name: latestSale?.grantee ?? comp.sale_owner_name,
    gis_owner_name: comp.owner_name,
    gis_sale_date: comp.sale_date ?? null,
    gis_sale_price: comp.sale_price ?? null,
    gis_snapshot_at: comp.gis_snapshot_at ?? null,
  };

  const land = merged.land_value;
  const building = merged.building_value;
  merged.likely_vacant_land = (building == null || building === 0) && land != null && land > 0;
  merged.has_improvements = building != null && building > 0;

  return merged;
}

export function applyBeaconToCompIndex(cache = loadBeaconCache()) {
  if (!fs.existsSync(COMP_INDEX_PATH)) {
    throw new Error(`Missing ${COMP_INDEX_PATH}`);
  }

  const lines = fs.readFileSync(COMP_INDEX_PATH, "utf8").trim().split("\n");
  const out = [];
  let updated = 0;
  const seen = new Set();

  for (const line of lines) {
    if (!line.trim()) continue;
    const comp = JSON.parse(line);
    if (seen.has(comp.parcel_id)) continue;
    seen.add(comp.parcel_id);

    const beacon = cache.get(comp.parcel_id);
    if (beacon?.status === "ok") {
      beacon.gis_owner_name = comp.owner_name;
      const merged = mergeCompWithBeacon(comp, beacon);
      if (merged.owner_name !== comp.owner_name) updated++;
      out.push(JSON.stringify(merged));
    } else {
      out.push(line);
    }
  }

  fs.writeFileSync(COMP_INDEX_BEACON_PATH, `${out.join("\n")}\n`);
  return { written: COMP_INDEX_BEACON_PATH, updated, total: out.length };
}

/** Alias used by enrich-from-beacon --apply */
export function applyBeaconToCompRecord(cache) {
  return applyBeaconToCompIndex(cache);
}

export function mergeLeadCardWithBeacon(card, beacon) {
  if (!beacon || beacon.status !== "ok") return card;

  const gisOwner =
    card.owner_name ??
    card.property?.cama_raw?.MAILING_NAME_1 ??
    card.property?.cama_raw?.OWNER1 ??
    null;
  const overlay = beaconOverlayForComp({ ...beacon, gis_owner_name: gisOwner });
  const latestSale = pickLatestValidSale(beacon.sales);

  return {
    ...card,
    address: overlay.parcel_address ?? card.address,
    owner_name: overlay.owner_name ?? card.owner_name,
    owner_source: "beacon",
    owner_fetched_at: overlay.owner_fetched_at,
    gis_owner_name: gisOwner,
    gis_owner_stale: overlay.gis_owner_stale ?? false,
    land_value: overlay.land_value ?? card.land_value,
    building_value: overlay.building_value ?? card.building_value,
    total_value: overlay.total_value ?? card.total_value,
    year_built: overlay.year_built ?? card.year_built,
    square_footage: overlay.square_footage ?? card.square_footage,
    last_sale_date: latestSale?.date ?? card.last_sale_date,
    last_sale_price: latestSale?.price ?? card.last_sale_price,
    beacon: {
      owner_name: beacon.owner_name ?? null,
      mailing_address: beacon.mailing_address ?? null,
      parcel_address: beacon.parcel_address ?? null,
      valuation: beacon.valuation ?? {},
      sales: beacon.sales ?? [],
      source_url: beacon.source_url ?? null,
      fetched_at: beacon.fetched_at ?? null,
    },
  };
}

/**
 * In-memory index of tax lien parcels for owner-name matching.
 */

import fs from "fs";
import { paths } from "../src/core/county-context.mjs";
import { findLatestTaxLienJson } from "../src/core/tax-lien-discovery.mjs";
import { pickBestNameMatch } from "./name-match.mjs";

let cachedParcels = null;
let cachedPath = null;

export function loadTaxLienParcels(jsonPath = null) {
  const resolved =
    jsonPath ??
    findLatestTaxLienJson(paths().dataRoot)?.path ??
    paths().file("tax-lien-list-10-21-2025.json");
  if (cachedParcels && cachedPath === resolved) return cachedParcels;
  if (!fs.existsSync(resolved)) return [];

  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const parcels = [];
  for (const district of raw.districts ?? []) {
    for (const parcel of district.parcels ?? []) {
      parcels.push({
        parcel_id: parcel.parcel_id,
        owner_name: parcel.owner_name,
        street_address: parcel.street_address,
        city: parcel.city,
        state: parcel.state,
        zip: parcel.zip,
        delinquent_year: parcel.delinquent_year ?? null,
        cert_status: parcel.cert_status ?? null,
      });
    }
  }
  cachedParcels = parcels;
  cachedPath = resolved;
  return parcels;
}

export function findTaxLienByOwnerName(defendantName, parcels = loadTaxLienParcels()) {
  const result = pickBestNameMatch(defendantName, parcels, { minScore: 50 });
  if (result.status !== "matched" || !result.match) return result;

  return {
    status: "matched",
    match: {
      parcel_id: result.match.parcel_id,
      owner_name: result.match.owner_name,
      property_address: result.match.street_address,
      city: result.match.city,
      state: result.match.state,
      zip: result.match.zip,
      match_score: result.match.score,
      match_source: "tax_lien_list",
    },
    candidates: [],
  };
}

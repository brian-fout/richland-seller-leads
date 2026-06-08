/**
 * @county richland — Fixed-width field positions for Ohio AA407 Regional .DAT exports.
 * Verified against Richland OWNDATMAX.DAT / ASMT.DAT / CHARGE.DAT (2025–2026 export).
 */

/** 1-based layout docs → 0-based slice [start, end) */
export const OWNDATMAX = {
  parcel_key: [0, 13],
  stub: [30, 33],
  tax_year: [37, 41],
  owner_type: [44, 45],
  owner_name_start: 45,
};

export const ASMT = {
  parcel_key: [0, 13],
  stub: [30, 33],
  tax_year: [37, 41],
  /** Values block begins at 41: class, land, building, ... */
  values_start: 41,
};

export const CHARGE = {
  parcel_key: [0, 13],
  stub: [30, 33],
  tax_year: [37, 41],
  /** Amount fields after header; index 5 ≈ prior delinquent (matches cert list). */
  prior_delinquent_amount_index: 5,
  amounts_start: 41,
  record_length: 501,
};

export function sliceField(line, [start, end]) {
  return line.slice(start, end);
}

/** DWELL.DAT — condition code at fixed offset (verified vs GIS Parcel_CAMA). */
export const DWELL = {
  parcel_key: [0, 13],
  condition: [253, 255],
  grade: [93, 96],
  record_length: 1177,
};

export function realisticTaxYear(value) {
  const year = parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(year)) return null;
  const maxYear = new Date().getUTCFullYear() + 1;
  if (year < 1990 || year > maxYear) return null;
  return year;
}

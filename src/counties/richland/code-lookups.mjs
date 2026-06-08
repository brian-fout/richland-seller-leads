/**
 * @county richland — Human labels for auditor/GIS coded fields.
 * Style labels are inferred from county data + common Ohio Tyler CAMA patterns;
 * verify against Richland's AA407_layout reference when available.
 */

/** Municipality codes observed in Parcel_CAMA (dominant city per code). */
export const MUNICIPALITY_LABELS = {
  3010: "Mansfield city",
  3015: "Mansfield city (alt district)",
  3020: "Shelby village",
  2030: "Lexington village",
  2010: "Bellville village",
  2020: "Butler village",
  2060: "Plymouth village",
  2040: "Lucas village",
  2070: "Shiloh village",
  3005: "Crestline",
  3008: "Galion",
  9999: "Unincorporated / township",
};

/**
 * Dwelling style codes (DWELL/GIS STYLE). Labels from Richland parcel stats
 * (avg story height by code) + typical Tyler CAMA residential styles.
 */
export const STYLE_LABELS = {
  1: "One story",
  2: "One story (variant)",
  3: "Ranch / one story",
  5: "Two story",
  6: "One story (basement / raised)",
  7: "Two story (variant)",
  8: "One-and-one-half story",
  9: "Bi-level",
  10: "Bi-level / split entry",
  11: "Split level",
  12: "Cape cod",
  14: "Manufactured / mobile (improved)",
  15: "Townhouse / row",
  20: "Condo / multi-unit style",
  23: "Apartment conversion",
  25: "Two story (older stock)",
};

export const CONDITION_LABELS = {
  VP: "Very poor",
  PR: "Poor",
  FR: "Fair",
  AV: "Average",
  GD: "Good",
  VG: "Very good",
  EX: "Excellent",
  UN: "Unsound",
  "P-": "Poor minus",
  "V-": "Very poor minus",
};

export function normalizeStyleCode(style) {
  if (style == null || style === "") return null;
  const n = parseInt(String(style).trim(), 10);
  return Number.isFinite(n) ? String(n) : String(style).trim();
}

export function labelStyle(style) {
  const key = normalizeStyleCode(style);
  if (!key) return null;
  return STYLE_LABELS[key] ?? `Style code ${key} (see auditor reference)`;
}

export function labelCondition(condition) {
  if (!condition) return null;
  const key = String(condition).trim().toUpperCase();
  return CONDITION_LABELS[key] ?? key;
}

export function labelMunicipality(municipality) {
  if (municipality == null || municipality === "") return null;
  const key = String(municipality).trim();
  return MUNICIPALITY_LABELS[key] ?? `Municipality code ${key}`;
}

/**
 * Richland NEIGHBORHOOD is an 8-digit assessing code (GIS may zero-pad).
 * Format: TTTTNNNN where TTTT = tax district (02704 → 027-04), NNNN often ends with nbhd seq.
 * Example: 2704008 / 02704008 → tax district 027-04, assessing neighborhood 8.
 */
export function parseNeighborhoodCode(neighborhood) {
  if (neighborhood == null || neighborhood === "") return null;
  const digits = String(neighborhood).replace(/\D/g, "");
  if (digits.length < 5) return { raw: neighborhood, tax_district: null, neighborhood_seq: null };

  const taxDistrict = `${digits.slice(0, 3)}-${digits.slice(3, 5)}`;
  const neighborhoodSeq = parseInt(digits.slice(5), 10) || null;
  return {
    raw: neighborhood,
    tax_district: taxDistrict,
    neighborhood_seq: neighborhoodSeq,
  };
}

export function labelNeighborhood(neighborhood, options = {}) {
  const parsed = parseNeighborhoodCode(neighborhood);
  if (!parsed) return null;

  const city = options.city ? String(options.city).trim() : null;
  const parts = [];
  if (city) parts.push(city);
  if (parsed.tax_district) parts.push(`tax district ${parsed.tax_district}`);
  if (parsed.neighborhood_seq != null) parts.push(`assessing nbhd ${parsed.neighborhood_seq}`);

  return parts.length ? parts.join(" — ") : `Neighborhood code ${parsed.raw}`;
}

export function enrichParcelCodes(parcel = {}) {
  return {
    style_code: normalizeStyleCode(parcel.style),
    style_label: labelStyle(parcel.style),
    condition_code: parcel.condition ?? null,
    condition_label: labelCondition(parcel.condition),
    grade: parcel.grade ?? null,
    municipality_code: parcel.municipality ?? null,
    municipality_label: labelMunicipality(parcel.municipality),
    neighborhood_code: parcel.neighborhood ?? null,
    neighborhood_parsed: parseNeighborhoodCode(parcel.neighborhood),
    neighborhood_label: labelNeighborhood(parcel.neighborhood, { city: parcel.city }),
  };
}

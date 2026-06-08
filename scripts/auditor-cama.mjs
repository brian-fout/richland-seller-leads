/**
 * Full Parcel_CAMA attribute fetch from Richland County ArcGIS REST.
 */

export const PARCEL_LAYER =
  "https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0";

/** Skip orphan geometries in the layer that have no parcel id. */
export const CAMA_PARCEL_WHERE = "PARCEL_ID IS NOT NULL AND PARCEL_ID <> ''";

function isRetryableFetchError(err) {
  const code = err?.cause?.code ?? err?.code ?? "";
  return !["ENOTFOUND", "ENETUNREACH", "EAI_AGAIN"].includes(code);
}

async function retryFetch(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      lastErr = err;
      if (!isRetryableFetchError(err)) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCamaValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asNum = Number(trimmed.replace(/[$,]/g, ""));
    if (Number.isFinite(asNum) && /^-?\d/.test(trimmed.replace(/[$,]/g, ""))) return asNum;
    return trimmed;
  }
  return value;
}

export function normalizeCamaAttributes(attrs) {
  if (!attrs) return null;
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = normalizeCamaValue(value);
  }
  return out;
}

const AUDITOR_KEY_RE =
  /(?:^|_)(?:LAND|BUILD|IMPROV|BLDG|CONDO|TOTAL|APPRAI|MARKET|ASSES|TAX|VALUE|ACRE|SQUARE|SQFT|YEAR|SALE|LAND_USE|CLASS|ZONING|OWNER|MAIL|PARCEL|LEGAL|DISTRICT|NEIGHBORHOOD|RESYR|BED|BATH|ROOM|STORY|STYLE|CONDITION|HEAT|BASEMENT|GARAGE|FIREPLACE)/i;

export function extractAuditorValues(camaRaw) {
  if (!camaRaw) return {};
  const out = {};
  for (const [key, value] of Object.entries(camaRaw)) {
    if (value == null || value === "") continue;
    if (AUDITOR_KEY_RE.test(key)) out[key] = value;
  }
  return out;
}

function firstNumber(attrs, keyPatterns) {
  if (!attrs) return null;
  for (const pattern of keyPatterns) {
    for (const [key, value] of Object.entries(attrs)) {
      if (pattern.test(key)) {
        const n = toNumber(value);
        if (n != null) return n;
      }
    }
  }
  return null;
}

function firstString(attrs, keyPatterns) {
  if (!attrs) return null;
  for (const pattern of keyPatterns) {
    for (const [key, value] of Object.entries(attrs)) {
      if (pattern.test(key)) {
        const text = String(value ?? "").trim();
        if (text) return text;
      }
    }
  }
  return null;
}

export function derivePropertyHints({ camaRaw, camaAuditor, taxLien } = {}) {
  const land =
    firstNumber(camaAuditor ?? camaRaw, [/LAND.*VALUE/i, /TOTAL_LAND/i, /APPRAISED_LAND/i]) ??
    toNumber(taxLien?.land_value);
  const building =
    firstNumber(camaAuditor ?? camaRaw, [
      /BUILD.*VALUE/i,
      /IMPROV.*VALUE/i,
      /BLDG.*VALUE/i,
      /APPRAISED_IMPROV/i,
      /TOTAL_IMPROV/i,
    ]) ?? toNumber(taxLien?.building_value);
  const total =
    firstNumber(camaAuditor ?? camaRaw, [
      /^TOTAL_VALUE$/i,
      /MARKET.*VALUE/i,
      /APPRAISED.*TOTAL/i,
      /TOTAL_APPRAISED/i,
    ]) ?? toNumber(taxLien?.total_value);

  const landUse =
    firstString(camaRaw, [/^LAND_USE_CODE$/i, /LAND_USE/i, /PROPERTY_CLASS/i, /CLASS_CODE/i]) ??
    null;
  const acres =
    firstNumber(camaRaw, [/^ACRES$/i, /ACREAGE/i, /LAND_AREA/i]) ?? toNumber(taxLien?.acres);
  const sqft = firstNumber(camaRaw, [/SQUARE_FOOTAGE/i, /SQFT/i, /BLDGAREA/i, /FLOOR_AREA/i]);

  const buildingZero = building == null || building === 0;
  const landPositive = land != null && land > 0;
  const likelyVacantLand = buildingZero && landPositive;
  const hasImprovements = building != null && building > 0;

  return {
    land_value: land,
    building_value: building,
    total_value: total,
    acres,
    square_footage: sqft,
    land_use_code: landUse,
    likely_vacant_land: likelyVacantLand,
    has_improvements: hasImprovements,
    building_to_land_ratio:
      land != null && land > 0 && building != null ? Math.round((building / land) * 100) / 100 : null,
  };
}

export function salesDateToIso(value) {
  const n = toNumber(value);
  if (n == null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function centroidFromGeometry(geometry) {
  const ring = geometry?.rings?.[0];
  if (!ring?.length) return { lat: null, lon: null };
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of ring) {
    sumX += x;
    sumY += y;
  }
  return { lon: sumX / ring.length, lat: sumY / ring.length };
}

export function toCompRecord(attrs, geometry = null) {
  if (!attrs) return null;
  const centroid = centroidFromGeometry(geometry);
  const land = toNumber(attrs.TOTAL_LAND_VALUE ?? attrs.APPRAISED_LAND_VALUE);
  const building = toNumber(attrs.TOTAL_BLDG_VALUE ?? attrs.APPRAISED_BLDG_VALUE);
  const sqft = toNumber(attrs.TOTAL_LIVING_AREA ?? attrs.SQUARE_FOOTAGE);
  const salePrice = toNumber(attrs.SALES_PRICE);

  return {
    parcel_id: attrs.PARCEL_ID ?? attrs.PARCELID ?? null,
    address: attrs.PARCEL_ADDRESS ?? attrs.LEGAL_ADDRESS ?? null,
    city: attrs.LEGAL_CITY ?? null,
    zip: attrs.LEGAL_ZIPCODE ?? null,
    owner_name: attrs.MAILING_NAME_1 ?? attrs.OWNER1 ?? null,
    land_use_code: attrs.LAND_USE_CODE ?? null,
    classification: attrs.CLASSIFICATION ?? null,
    neighborhood: attrs.NEIGHBORHOOD ?? null,
    municipality: attrs.MUNICIPALITY ?? null,
    acres: toNumber(attrs.CALCULATED_ACRES ?? attrs.ACRES),
    square_footage: sqft,
    year_built: toNumber(attrs.YEAR_BUILT),
    bedrooms: toNumber(attrs.BEDROOMS),
    full_bath: toNumber(attrs.FULL_BATH),
    half_bath: toNumber(attrs.HALF_BATH),
    stories: toNumber(attrs.STORIES),
    style: attrs.STYLE ?? null,
    condition: attrs.CONDITION ?? null,
    grade: attrs.GRADE ?? null,
    land_value: land,
    building_value: building,
    total_appraised_value: toNumber(attrs.TOTAL_APPRAISED_VALUE),
    market_value: toNumber(attrs.MARKET_VALUE),
    likely_vacant_land: (building == null || building === 0) && land != null && land > 0,
    has_improvements: building != null && building > 0,
    sale_date: salesDateToIso(attrs.SALES_DATE),
    sale_price: salePrice,
    sale_book: attrs.SALES_BOOK ?? null,
    sale_page: attrs.SALES_PAGE ?? null,
    sale_validity_code: attrs.SALES_VALIDITY_CODE ?? null,
    sale_type: attrs.SALES_TYPE ?? null,
    sale_instrument: attrs.SALES_INSTRUMENT_TYPE ?? null,
    sale_old_owner: attrs.SALES_OLD_OWNER ?? null,
    sale_owner_name: attrs.SALES_OWNER_NAME ?? null,
    lat: centroid.lat,
    lon: centroid.lon,
  };
}

export async function queryCamaParcelCount() {
  const url = `${PARCEL_LAYER}/query?where=${encodeURIComponent(CAMA_PARCEL_WHERE)}&returnCountOnly=true&f=json`;
  const response = await retryFetch(url);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.count ?? 0;
}

export async function queryCamaParcelPage({
  resultOffset = 0,
  recordCount = 1000,
  returnGeometry = false,
} = {}) {
  const params = new URLSearchParams({
    where: CAMA_PARCEL_WHERE,
    outFields: "*",
    returnGeometry: returnGeometry ? "true" : "false",
    f: "json",
    resultRecordCount: String(recordCount),
    resultOffset: String(resultOffset),
    orderByFields: "OBJECTID",
  });
  if (returnGeometry) params.set("outSR", "4326");

  const url = `${PARCEL_LAYER}/query?${params}`;
  const response = await retryFetch(url);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

  return (json.features ?? []).map((feature) => ({
    attributes: normalizeCamaAttributes(feature.attributes ?? null),
    geometry: feature.geometry ?? null,
  }));
}

export async function queryParcelCamaById(parcelId, cache, options = {}) {
  const key = `cama:${parcelId}`;
  if (!options.force && cache?.has(key)) return cache.get(key);

  const where = `PARCEL_ID='${escapeSql(parcelId)}'`;
  const url = `${PARCEL_LAYER}/query?where=${encodeURIComponent(where)}&outFields=*&returnGeometry=false&f=json&resultRecordCount=1`;

  let result;
  try {
    const response = await retryFetch(url);
    const json = await response.json();
    if (json.error) {
      result = {
        status: "error",
        parcel_id: parcelId,
        fetched_at: new Date().toISOString(),
        cama_raw: null,
        error: json.error.message || JSON.stringify(json.error),
      };
    } else {
      const attrs = normalizeCamaAttributes(json.features?.[0]?.attributes ?? null);
      result = attrs
        ? {
            status: "ok",
            parcel_id: parcelId,
            fetched_at: new Date().toISOString(),
            cama_raw: attrs,
            error: null,
          }
        : {
            status: "not_found",
            parcel_id: parcelId,
            fetched_at: new Date().toISOString(),
            cama_raw: null,
            error: null,
          };
    }
  } catch (err) {
    result = {
      status: "error",
      parcel_id: parcelId,
      fetched_at: new Date().toISOString(),
      cama_raw: null,
      error: err.cause?.code ?? err.message,
    };
  }

  if (cache) cache.set(key, result);
  if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
  return result;
}

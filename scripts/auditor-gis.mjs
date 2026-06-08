/**
 * Richland County auditor parcel lookup via ArcGIS REST (no auth).
 */

import { personNameMatchScore, personNameTokens } from "./name-match.mjs";

const PARCEL_LAYER =
  "https://maps.richlandcountyoh.us/richlandgis/rest/services/Parcel_CAMA/MapServer/0";

function isRetryableFetchError(err) {
  const code = err?.cause?.code ?? err?.code ?? "";
  return !["ENOTFOUND", "ENETUNREACH", "EAI_AGAIN"].includes(code);
}

async function retryFetch(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch (err) {
      lastErr = err;
      if (!isRetryableFetchError(err)) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

const STREET_REPLACEMENTS = [
  [/\bAVENUE\b/g, "AVE"],
  [/\bAV\b/g, "AVE"],
  [/\bSTREET\b/g, "ST"],
  [/\bROAD\b/g, "RD"],
  [/\bDRIVE\b/g, "DR"],
  [/\bLANE\b/g, "LN"],
  [/\bCOURT\b/g, "CT"],
  [/\bCIRCLE\b/g, "CIR"],
  [/\bBOULEVARD\b/g, "BLVD"],
  [/\bHIGHWAY\b/g, "HWY"],
  [/\bPLACE\b/g, "PL"],
  [/\bTRAIL\b/g, "TRL"],
  [/\bPARKWAY\b/g, "PKWY"],
];

export function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStreetAddress(address) {
  let s = clean(address).toUpperCase();
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\b(?:LOT|UNIT|APT|APARTMENT|STE|SUITE|#)\s*[\w-]+/gi, " ");
  s = s.replace(/[^A-Z0-9\s]/g, " ");
  for (const [re, rep] of STREET_REPLACEMENTS) s = s.replace(re, rep);
  return s.replace(/\s+/g, " ").trim();
}

export function buildAddressLikePattern(address) {
  const norm = normalizeStreetAddress(address);
  const parts = norm.split(" ").filter(Boolean);
  if (parts.length === 0) return null;

  const houseNum = /^\d+[A-Z]?$/.test(parts[0]) ? parts[0] : null;
  const skip = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "OH"]);
  const words = parts.filter((p, i) => !(houseNum && i === 0) && !skip.has(p) && p.length > 1);
  if (words.length === 0) return houseNum ? `%${houseNum}%` : null;

  const core = words.slice(0, 2);
  if (houseNum) return `%${houseNum}%${core.join("%")}%`;
  return `%${core.join("%")}%`;
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function scoreAddressMatch(searchAddress, candidateAddress) {
  const search = normalizeStreetAddress(searchAddress);
  const candidate = normalizeStreetAddress(candidateAddress);
  if (!search || !candidate) return 0;
  if (search === candidate) return 100;

  const searchNum = search.match(/^(\d+[A-Z]?)\b/)?.[1] ?? null;
  const candidateNum = candidate.match(/^(\d+[A-Z]?)\b/)?.[1] ?? null;
  if (searchNum && candidateNum && searchNum !== candidateNum) return 0;

  const searchTokens = new Set(search.split(" ").filter((t) => t.length > 1));
  const overlap = candidate
    .split(" ")
    .filter((t) => t.length > 1 && searchTokens.has(t)).length;
  return overlap * 15;
}

export function pickBestParcelMatch(searchAddress, features) {
  if (!features?.length) return { status: "not_found", match: null, candidates: [] };

  const scored = features
    .map((f) => ({
      parcel_id: f.attributes?.PARCEL_ID ?? null,
      parcel_address: f.attributes?.PARCEL_ADDRESS ?? null,
      owner_name: f.attributes?.MAILING_NAME_1 ?? null,
      score: scoreAddressMatch(searchAddress, f.attributes?.PARCEL_ADDRESS ?? ""),
    }))
    .filter((r) => r.parcel_id && r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { status: "not_found", match: null, candidates: [] };

  const best = scored[0];
  const tied = scored.filter((r) => r.score === best.score);
  if (tied.length > 1) {
    return { status: "ambiguous", match: null, candidates: tied.slice(0, 5) };
  }
  if (best.score < 15) return { status: "not_found", match: null, candidates: scored.slice(0, 3) };

  return {
    status: "matched",
    match: {
      parcel_id: best.parcel_id,
      parcel_address: best.parcel_address,
      owner_name: best.owner_name,
      match_score: best.score,
    },
    candidates: [],
  };
}

export async function queryParcelsByAddressLike(pattern, { recordCount = 10 } = {}) {
  const where = `PARCEL_ADDRESS LIKE '${escapeSql(pattern.toUpperCase())}'`;
  const url = `${PARCEL_LAYER}/query?where=${encodeURIComponent(where)}&outFields=PARCEL_ID,PARCEL_ADDRESS,MAILING_NAME_1&returnGeometry=false&f=json&resultRecordCount=${recordCount}`;
  const response = await retryFetch(url);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.features ?? [];
}

export async function lookupParcelByAddress(address, cache, options = {}) {
  const key = normalizeStreetAddress(address);
  if (!key) return { status: "not_found", match: null, candidates: [] };
  if (cache.has(key)) return cache.get(key);

  const patterns = [buildAddressLikePattern(address)].filter(Boolean);
  const norm = normalizeStreetAddress(address);
  const withoutSuffix = norm.replace(/\b(AVE|ST|RD|DR|LN|CT|CIR|BLVD|HWY|PL|TRL|PKWY)\b\.?$/, "").trim();
  if (withoutSuffix && withoutSuffix !== norm) {
    patterns.push(buildAddressLikePattern(withoutSuffix));
  }

  let features = [];
  for (const pattern of [...new Set(patterns)]) {
    try {
      features = await queryParcelsByAddressLike(pattern, options);
    } catch (err) {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      features = await queryParcelsByAddressLike(pattern, options);
    }
    if (features.length) break;
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
  }

  const result = pickBestParcelMatch(address, features);
  cache.set(key, result);
  if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
  return result;
}

export function pickBestOwnerMatch(searchName, features) {
  if (!features?.length) return { status: "not_found", match: null, candidates: [] };

  const scored = features
    .map((f) => ({
      parcel_id: f.attributes?.PARCEL_ID ?? null,
      parcel_address: f.attributes?.PARCEL_ADDRESS ?? null,
      owner_name: f.attributes?.MAILING_NAME_1 ?? null,
      score: personNameMatchScore(searchName, f.attributes?.MAILING_NAME_1 ?? ""),
    }))
    .filter((r) => r.parcel_id && r.score >= 50)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { status: "not_found", match: null, candidates: [] };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { status: "ambiguous", match: null, candidates: scored.slice(0, 5) };
  }

  return {
    status: "matched",
    match: {
      parcel_id: scored[0].parcel_id,
      parcel_address: scored[0].parcel_address,
      owner_name: scored[0].owner_name,
      match_score: scored[0].score,
    },
    candidates: [],
  };
}

export async function queryParcelsByOwnerLike(pattern, { recordCount = 15 } = {}) {
  const where = `MAILING_NAME_1 LIKE '${escapeSql(pattern.toUpperCase())}'`;
  const url = `${PARCEL_LAYER}/query?where=${encodeURIComponent(where)}&outFields=PARCEL_ID,PARCEL_ADDRESS,MAILING_NAME_1&returnGeometry=false&f=json&resultRecordCount=${recordCount}`;
  const response = await retryFetch(url);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.features ?? [];
}

export async function lookupParcelByOwnerName(name, cache, options = {}) {
  const tokens = personNameTokens(name);
  if (tokens.length < 2) return { status: "not_found", match: null, candidates: [] };

  const cacheKey = `owner:${tokens.join("|")}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const patterns = [
    `%${tokens[0]}%${tokens[1]}%`,
    tokens.length >= 3 ? `%${tokens[0]}%${tokens[1]}%${tokens[2]}%` : null,
  ].filter(Boolean);

  let features = [];
  for (const pattern of [...new Set(patterns)]) {
    try {
      features = await queryParcelsByOwnerLike(pattern, options);
    } catch (err) {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      features = await queryParcelsByOwnerLike(pattern, options);
    }
    if (features.length) break;
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
  }

  const result = pickBestOwnerMatch(name, features);
  cache.set(cacheKey, result);
  if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
  return result;
}

export async function lookupParcelById(parcelId, cache) {
  const key = `id:${parcelId}`;
  if (cache.has(key)) return cache.get(key);

  const where = `PARCEL_ID='${escapeSql(parcelId)}'`;
  const url = `${PARCEL_LAYER}/query?where=${encodeURIComponent(where)}&outFields=PARCEL_ID,PARCEL_ADDRESS,MAILING_NAME_1&returnGeometry=false&f=json&resultRecordCount=1`;
  const response = await retryFetch(url);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

  const attrs = json.features?.[0]?.attributes;
  const result = attrs
    ? {
        status: "matched",
        match: {
          parcel_id: attrs.PARCEL_ID,
          parcel_address: attrs.PARCEL_ADDRESS,
          owner_name: attrs.MAILING_NAME_1,
          match_score: 100,
        },
        candidates: [],
      }
    : { status: "not_found", match: null, candidates: [] };

  cache.set(key, result);
  return result;
}

export function applyParcelLookup(record, lookup) {
  if (lookup.status === "matched" && lookup.match) {
    return {
      ...record,
      parcel_id: lookup.match.parcel_id,
      auditor_parcel_address: lookup.match.parcel_address ?? null,
      auditor_owner_name: lookup.match.owner_name ?? null,
      parcel_lookup: "matched",
    };
  }
  if (lookup.status === "ambiguous") {
    return {
      ...record,
      parcel_lookup: "ambiguous",
      parcel_candidates: lookup.candidates,
    };
  }
  return { ...record, parcel_lookup: "not_found" };
}

export function needsParcelLookup(record, { force = false } = {}) {
  if (force) return Boolean(recordStreet(record));
  return !record.parcel_id && Boolean(recordStreet(record));
}

export function recordStreet(record) {
  return clean(record.property_address ?? record.street_address ?? "");
}

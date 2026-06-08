/**
 * @shared ARV CLI — delegates to canonical src/arv/arvEngine.js + county adapter.
 *
 * Usage:
 *   npm run estimate:arv -- 027-04-044-07-000
 *   npm run estimate:arv -- 027-04-044-07-000 --format table --county richland
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths } from "../src/core/county-context.mjs";
import { computeArv, formatArvPackage } from "../src/arv/arvEngine.js";
import { buildCompsForSubject, subjectFromParcel } from "../src/arv/countyAdapter.js";
import {
  enrichParcelCodes,
  labelNeighborhood,
  labelStyle,
} from "../src/counties/richland/code-lookups.mjs";

const p = paths();
const COMP_INDEX_AUDITOR = p.compIndexAuditor;
const SALES_EVENTS = p.salesEvents;

const EARTH_MI = 3958.8;

export const WHOLESALE_ARV_DEFAULTS = {
  radiusMi: 0.5,
  months: 18,
  sqftBand: 0.25,
  minRetailPrice: 35000,
  minRetailPpsf: 35,
  maxAsIsPrice: 28000,
  maxAsIsPpsf: 24,
  minRetailComps: 3,
  maxSpreadRatio: 1.75,
  minCompsHighConfidence: 4,
};

function parseArgs() {
  const parcelIdx = process.argv.indexOf("--parcel");
  const radiusIdx = process.argv.indexOf("--radius-mi");
  const monthsIdx = process.argv.indexOf("--months");
  const formatIdx = process.argv.indexOf("--format");
  const positional = process.argv.find((a) => /^\d{3}-\d{2}-\d{3}-\d{2}-\d{3}$/.test(a));
  return {
    parcelId:
      parcelIdx >= 0 ? process.argv[parcelIdx + 1] : positional ?? "027-04-044-07-000",
    radiusMi: radiusIdx >= 0 ? parseFloat(process.argv[radiusIdx + 1]) : WHOLESALE_ARV_DEFAULTS.radiusMi,
    months: monthsIdx >= 0 ? parseInt(process.argv[monthsIdx + 1], 10) : WHOLESALE_ARV_DEFAULTS.months,
    format: formatIdx >= 0 ? process.argv[formatIdx + 1] : "json",
  };
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(a));
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function landUseBucket(code) {
  if (code == null) return null;
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  if (n >= 500 && n < 520) return "sfd";
  if (n >= 520 && n < 540) return "multi";
  if (n >= 500) return "res";
  return "other";
}

function loadCompIndex() {
  const file = fs.existsSync(COMP_INDEX_AUDITOR)
    ? COMP_INDEX_AUDITOR
    : p.compIndex;
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
  return records;
}

export function loadSalesEvents() {
  if (!fs.existsSync(SALES_EVENTS)) return null;
  const events = [];
  for (const line of fs.readFileSync(SALES_EVENTS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line));
  }
  return events;
}

export function loadArvContext() {
  const subjects = loadCompIndex();
  const salesEvents = loadSalesEvents();
  const compPool = salesEvents ?? subjects;
  return {
    subjects,
    compPool,
    salesEvents,
    subjectsByParcel: buildCompIndexByParcel(subjects),
    spatialIndex: buildSpatialIndex(compPool),
  };
}

export function buildCompIndexByParcel(records) {
  return new Map(records.map((rec) => [rec.parcel_id, rec]));
}

export function buildSpatialIndex(records, cellSize = 0.01) {
  const grid = new Map();
  for (const rec of records) {
    if (rec.lat == null || rec.lon == null) continue;
    const key = `${Math.floor(rec.lat / cellSize)},${Math.floor(rec.lon / cellSize)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(rec);
  }
  return { grid, cellSize };
}

export function getNearbyRecords(spatialIndex, lat, lon, radiusMi) {
  const { grid, cellSize } = spatialIndex;
  const cellRadius = Math.ceil(radiusMi / 69 / cellSize) + 1;
  const latCell = Math.floor(lat / cellSize);
  const lonCell = Math.floor(lon / cellSize);
  const nearby = [];
  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const bucket = grid.get(`${latCell + dy},${lonCell + dx}`);
      if (bucket) nearby.push(...bucket);
    }
  }
  return nearby;
}

function saleWithinMonths(saleDate, months) {
  if (!saleDate) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return saleDate >= cutoff.toISOString().slice(0, 10);
}

function sqftInBand(subjectSqft, compSqft, band) {
  if (!subjectSqft || !compSqft) return true;
  const ratio = compSqft / subjectSqft;
  return ratio >= 1 - band && ratio <= 1 + band;
}

function mapComp(rec, subject, args) {
  const salePrice = rec.sale_price ?? rec.auditor_sale_price;
  const sqft = rec.square_footage;
  const dist = haversineMi(subject.lat, subject.lon, rec.lat, rec.lon);
  const assessed = (rec.land_value ?? rec.auditor_land_value ?? 0) + (rec.building_value ?? rec.auditor_building_value ?? 0);
  const ppsf = sqft && sqft > 0 ? Math.round((salePrice / sqft) * 100) / 100 : null;
  return {
    parcel_id: rec.parcel_id,
    event_id: rec.event_id ?? null,
    address: rec.address,
    sale_date: rec.sale_date ?? rec.auditor_sale_date,
    sale_price: salePrice,
    square_footage: sqft,
    land_use_code: rec.land_use_code,
    neighborhood: rec.neighborhood ?? null,
    condition: rec.condition ?? null,
    grade: rec.grade ?? null,
    grantor: rec.grantor ?? null,
    distance_mi: Math.round(dist * 1000) / 1000,
    price_per_sqft: ppsf,
    sale_to_assessed: assessed > 0 ? Math.round((salePrice / assessed) * 100) / 100 : null,
  };
}

function isBaseCandidate(rec, subject, args) {
  if (rec.parcel_id === subject.parcel_id) return false;
  if (rec.lat == null || rec.lon == null || subject.lat == null || subject.lon == null) return false;
  if (haversineMi(subject.lat, subject.lon, rec.lat, rec.lon) > args.radiusMi) return false;

  const saleDate = rec.sale_date ?? rec.auditor_sale_date ?? null;
  const salePrice = rec.sale_price ?? rec.auditor_sale_price ?? null;
  if (!saleWithinMonths(saleDate, args.months)) return false;
  if (!salePrice || salePrice < 5000) return false;

  const validity = rec.validity_code ?? rec.auditor_sale_validity_code;
  if (validity != null && validity !== 2) return false;

  const subBucket = landUseBucket(subject.land_use_code);
  const compBucket = landUseBucket(rec.land_use_code);
  if (subBucket && compBucket && subBucket !== compBucket) return false;
  if (subject.has_improvements && !rec.has_improvements) return false;

  const sqft = rec.square_footage;
  if (!sqft || sqft < 400) return false;
  if (!sqftInBand(subject.square_footage, sqft, args.sqftBand)) return false;

  return true;
}

export function isAsIsComp(c, cfg = WHOLESALE_ARV_DEFAULTS) {
  if (!c.price_per_sqft) return true;
  return c.sale_price <= cfg.maxAsIsPrice || c.price_per_sqft <= cfg.maxAsIsPpsf;
}

export function isRetailRehabComp(c, cfg = WHOLESALE_ARV_DEFAULTS) {
  if (!c.price_per_sqft || isAsIsComp(c, cfg)) return false;
  if (c.sale_price >= cfg.minRetailPrice) return true;
  if (c.price_per_sqft >= cfg.minRetailPpsf) return true;
  if (c.sale_to_assessed >= 1.5 && c.sale_price >= 30000) return true;
  return false;
}

export function trimOutlierComps(comps) {
  if (comps.length < 4) return { kept: comps, removed: 0 };
  const ppsf = comps.map((c) => c.price_per_sqft).sort((a, b) => a - b);
  const q1 = percentile(ppsf, 0.25);
  const q3 = percentile(ppsf, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = comps.filter((c) => c.price_per_sqft >= lo && c.price_per_sqft <= hi);
  return { kept: kept.length ? kept : comps, removed: comps.length - kept.length };
}

function pickCompPool(mapped, subject, cfg) {
  const sameNbhd = subject.neighborhood
    ? mapped.filter((c) => c.neighborhood === subject.neighborhood)
    : [];
  const retailSame = sameNbhd.filter((c) => isRetailRehabComp(c, cfg));
  if (retailSame.length >= cfg.minRetailComps) {
    return { pool: retailSame, scope: "neighborhood_retail" };
  }

  const retailAll = mapped.filter((c) => isRetailRehabComp(c, cfg));
  if (retailAll.length >= cfg.minRetailComps) {
    return { pool: retailAll, scope: "radius_retail" };
  }

  const relaxed = mapped.filter((c) => !isAsIsComp(c, cfg));
  if (relaxed.length >= cfg.minRetailComps) {
    return { pool: relaxed, scope: "radius_relaxed" };
  }

  return { pool: mapped.filter((c) => !isAsIsComp(c, cfg)), scope: "insufficient_retail" };
}

function scoreWholesaleConfidence(retailComps, arv, cfg) {
  const n = retailComps.length;
  if (!arv?.mid || n === 0) {
    return {
      level: "none",
      score: 0,
      trustworthy_for_wholesale: false,
      review_required: true,
      reason: "No retail rehab comps after filters",
    };
  }

  const spread = arv.high / arv.mid;
  const reviewRequired = n < cfg.minRetailComps || spread > cfg.maxSpreadRatio;

  if (n >= cfg.minCompsHighConfidence && spread <= 1.4) {
    return {
      level: "high",
      score: 0.9,
      trustworthy_for_wholesale: true,
      review_required: false,
      reason: `${n} retail comps, tight spread (${spread.toFixed(2)}x)`,
    };
  }

  if (n >= cfg.minRetailComps && spread <= cfg.maxSpreadRatio) {
    return {
      level: "medium",
      score: 0.65,
      trustworthy_for_wholesale: true,
      review_required: true,
      reason: `${n} retail comps — verify before marketing (${spread.toFixed(2)}x spread)`,
    };
  }

  return {
    level: "low",
    score: 0.3,
    trustworthy_for_wholesale: false,
    review_required: true,
    reason:
      n < cfg.minRetailComps
        ? `Only ${n} retail comp(s) — do not rely on ARV for offers`
        : `Wide spread (${spread.toFixed(2)}x) — manual comp review required`,
  };
}

function wholesaleConfidenceFromEngine(engineResult, cfg) {
  const retailN = engineResult.pools?.renovated_after_filters ?? 0;
  const mid = engineResult.most_likely_arv;
  const low = engineResult.low_arv;
  const high = engineResult.high_arv;

  if (!mid || retailN === 0) {
    return {
      level: "none",
      score: 0,
      trustworthy_for_wholesale: false,
      review_required: true,
      reason: "No renovated comps after Mansfield filters",
      engine_pct: engineResult.confidence?.pct ?? 0,
    };
  }

  const spread = low && mid ? high / low : 2;

  if (retailN >= cfg.minCompsHighConfidence && spread <= 1.4) {
    return {
      level: "high",
      score: 0.9,
      trustworthy_for_wholesale: true,
      review_required: false,
      reason: `${retailN} renovated comps, tight spread (${spread.toFixed(2)}x)`,
      engine_pct: engineResult.confidence?.pct ?? 0,
    };
  }

  if (retailN >= cfg.minRetailComps && spread <= cfg.maxSpreadRatio) {
    return {
      level: "medium",
      score: 0.65,
      trustworthy_for_wholesale: true,
      review_required: true,
      reason: `${retailN} renovated comps — verify before marketing (${spread.toFixed(2)}x spread)`,
      engine_pct: engineResult.confidence?.pct ?? 0,
    };
  }

  return {
    level: "low",
    score: 0.3,
    trustworthy_for_wholesale: false,
    review_required: true,
    reason:
      retailN < cfg.minRetailComps
        ? `Only ${retailN} renovated comp(s) — manual review required`
        : `Wide spread (${spread.toFixed(2)}x) — manual comp review required`,
    engine_pct: engineResult.confidence?.pct ?? 0,
  };
}

function buildMapPayload(subject, comps, engineResult) {
  const includedIds = new Set((engineResult.comp_weighting ?? []).map((c) => c.address));
  const renovated = comps.filter((c) => c.renovated && c.distance != null && c.distance <= 0.501);

  return {
    subject: {
      parcel_id: subject.parcel_id,
      address: subject.address ?? null,
      city: subject.city ?? null,
      ...enrichParcelCodes(subject),
      lat: subject.lat ?? null,
      lon: subject.lon ?? null,
    },
    included: renovated.slice(0, 25).map((c) => ({
      parcel_id: c.parcel_id,
      address: c.address,
      city: c.city ?? null,
      style_code: c.style ?? null,
      style_label: labelStyle(c.style),
      neighborhood_code: c.neighborhood ?? null,
      neighborhood_label: labelNeighborhood(c.neighborhood, { city: c.city }),
      lat: c.lat,
      lon: c.lon,
      price: c.price,
      ppsf: c.sqft ? Math.round((c.price / c.sqft) * 100) / 100 : null,
      distance_mi: c.distance,
      renovated: c.renovated,
      in_weight_table: includedIds.has(c.address),
    })),
    stats: {
      total_input: comps.length,
      renovated_within_half_mi: renovated.length,
      same_neighborhood: subject.neighborhood
        ? renovated.filter((c) => c.neighborhood === subject.neighborhood).length
        : null,
      same_city: subject.city
        ? renovated.filter((c) => String(c.city ?? "").toUpperCase() === String(subject.city).toUpperCase()).length
        : null,
    },
  };
}

function buildAsIsAnchor(subject, allMapped, cfg) {
  const lastSale = subject.auditor_sale_price ?? subject.sale_price;
  const lastDate = subject.auditor_sale_date ?? subject.sale_date;
  if (lastSale && lastDate) {
    return { price: lastSale, date: lastDate, source: "subject_last_sale" };
  }
  const asIs = allMapped
    .filter((c) => isAsIsComp(c, cfg))
    .sort((a, b) => b.sale_date.localeCompare(a.sale_date) || a.distance_mi - b.distance_mi);
  if (asIs[0]) {
    return { price: asIs[0].sale_price, date: asIs[0].sale_date, source: "nearest_as_is_comp" };
  }
  return null;
}

export function estimateArv(subject, allRecords, options = {}) {
  const cfg = { ...WHOLESALE_ARV_DEFAULTS, ...options };

  if (
    subject.likely_vacant_land ||
    (!subject.has_improvements && (subject.building_value == null || subject.building_value === 0))
  ) {
    return {
      parcel_id: subject.parcel_id,
      address: subject.address,
      subject_sqft: subject.square_footage,
      land_use_code: subject.land_use_code,
      radius_mi: cfg.radiusMi,
      lookback_months: cfg.months,
      comp_count: 0,
      comp_count_retail: 0,
      confidence: {
        level: "none",
        score: 0,
        trustworthy_for_wholesale: false,
        review_required: true,
        reason: "Vacant land — ARV not applicable",
      },
      arv: null,
      skipped: "vacant_land",
      methodology: "arv_engine_v1",
    };
  }

  const pool = cfg.spatialIndex
    ? getNearbyRecords(cfg.spatialIndex, subject.lat, subject.lon, cfg.radiusMi)
    : allRecords;
  const comps = buildCompsForSubject(subject, pool, cfg.parcelLookup, {
    months: cfg.months,
    maxMi: cfg.radiusMi,
  });
  const weighted = {
  parcel_id: subject.parcel_id,
  address: subject.address,
  city: subject.city ?? null,
  ...enrichParcelCodes(subject),
  ...computeArv(subjectFromParcel(subject), comps, { market: cfg.market ?? "mansfield" }),
  };
  weighted.confidence_engine = weighted.confidence;
  weighted.confidence = wholesaleConfidenceFromEngine(weighted, cfg);
  weighted.map = buildMapPayload(subject, comps, weighted);
  weighted.arv = weighted.low_arv != null
    ? { low: weighted.low_arv, mid: weighted.most_likely_arv, high: weighted.high_arv }
    : null;
  weighted.marketing_arv = weighted.most_likely_arv != null
    ? { price: weighted.most_likely_arv, basis: "weighted_0.6_low_0.4_high" }
    : null;

  const legacyComps = (weighted.comp_weighting ?? []).map((c) => ({
    address: c.address,
    sale_price: c.price,
    price_per_sqft: c.ppsf,
    distance_mi: c.distance,
    weight: c.weight,
    similarity: c.similarity,
  }));

  return {
    ...weighted,
    subject_sqft: subject.square_footage,
    land_use_code: subject.land_use_code,
    neighborhood: subject.neighborhood ?? null,
    radius_mi: cfg.radiusMi,
    lookback_months: cfg.months,
    comp_count: weighted.comp_weighting?.length ?? 0,
    comp_count_retail: weighted.pools?.renovated_after_filters ?? 0,
    comp_scope: weighted.pools?.low_scope ?? null,
    confidence: weighted.confidence,
    confidence_engine: weighted.confidence_engine,
    marketing_arv: weighted.marketing_arv,
    as_is_anchor: buildAsIsAnchor(
      subject,
      legacyComps.map((c) => ({
        sale_price: c.sale_price,
        sale_date: null,
        price_per_sqft: c.price_per_sqft,
        distance_mi: c.distance_mi,
      })),
      cfg
    ),
    auditor_last_sale: {
      date: subject.auditor_sale_date ?? subject.sale_date,
      price: subject.auditor_sale_price ?? subject.sale_price,
    },
    comps: cfg.includeComps === false ? undefined : legacyComps.slice(0, cfg.maxComps ?? 15),
  };
}

export function slimArvResult(result) {
  return {
    parcel_id: result.parcel_id,
    comp_count: result.comp_count,
    comp_count_retail: result.comp_count_retail,
    comp_scope: result.comp_scope,
    confidence: result.confidence,
    trustworthy_for_wholesale: result.confidence?.trustworthy_for_wholesale ?? false,
    review_required: result.confidence?.review_required ?? true,
    arv: result.arv,
    low_arv: result.low_arv,
    high_arv: result.high_arv,
    most_likely_arv: result.most_likely_arv,
    confidence_pct: result.confidence?.engine_pct ?? result.confidence_engine?.pct ?? null,
    marketing_arv: result.marketing_arv,
    as_is_anchor: result.as_is_anchor,
    radius_mi: result.radius_mi,
    lookback_months: result.lookback_months,
    subject_sqft: result.subject_sqft,
    land_use_code: result.land_use_code,
    methodology: result.methodology ?? "arv_engine_v1",
  };
}

function main() {
  const args = parseArgs();
  const { subjectsByParcel, compPool, spatialIndex } = loadArvContext();
  const subject = subjectsByParcel.get(args.parcelId);
  if (!subject) {
    console.error(`Parcel not found: ${args.parcelId}`);
    process.exit(1);
  }

  const result = estimateArv(subject, compPool, {
    ...args,
    spatialIndex,
    parcelLookup: subjectsByParcel,
    includeComps: true,
  });
  if (args.format === "table" || args.format === "text") {
    console.log(formatArvPackage(result));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

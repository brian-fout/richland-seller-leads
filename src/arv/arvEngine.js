/**
 * ARV Engine — canonical implementation.
 * All ARV calculations in this project MUST call computeArv() from this module.
 *
 * @see ARV Engine Specification (do not modify formulas without updating spec)
 */

const LOW_RADIUS_MI = 0.25;
const MAX_RADIUS_MI = 0.5;
const ERA_BAND_YEARS = 20;
const SQFT_BAND = 0.2;
const LOW_ARV_WEIGHT = 0.6;
const HIGH_ARV_WEIGHT = 0.4;
const WEIGHT_DISTANCE = 0.4;
const WEIGHT_SQFT = 0.2;
const WEIGHT_BED_BATH = 0.2;
const WEIGHT_RECENCY = 0.2;
const MANSFIELD_RECENCY_MONTHS_THRESHOLD = 6;
const MANSFIELD_PPSF_CV_THRESHOLD = 0.2;
const LOOKBACK_MONTHS = 18;

function toDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthsSince(saleDate, asOf = new Date()) {
  const d = toDate(saleDate);
  if (!d) return null;
  return Math.max(0, (asOf - d) / (1000 * 60 * 60 * 24 * 30.4375));
}

function ppsf(comp) {
  if (!comp.sqft || comp.sqft <= 0 || !comp.price) return null;
  return comp.price / comp.sqft;
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

export function median(values) {
  if (!values.length) return null;
  return percentile(values, 0.5);
}

export function populationVariance(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

function normalizeStyle(style) {
  if (style == null) return "";
  return String(style).trim().toUpperCase();
}

function sameBedBath(subject, comp) {
  return subject.beds === comp.beds && subject.baths === comp.baths;
}

function sameStyle(subject, comp) {
  return normalizeStyle(subject.style) === normalizeStyle(comp.style);
}

function sameEra(subject, comp) {
  if (!subject.yearBuilt || !comp.yearBuilt) return true;
  return Math.abs(comp.yearBuilt - subject.yearBuilt) <= ERA_BAND_YEARS;
}

function similarSqft(subject, comp) {
  if (!subject.sqft || !comp.sqft) return true;
  const ratio = comp.sqft / subject.sqft;
  return ratio >= 1 - SQFT_BAND && ratio <= 1 + SQFT_BAND;
}

function excludeTopQuarterPpsf(comps) {
  if (comps.length < 4) return { kept: comps, excluded: [] };
  const ppsfValues = comps.map((c) => ppsf(c)).filter((v) => v != null);
  const cutoff = percentile(ppsfValues, 0.75);
  const kept = comps.filter((c) => ppsf(c) <= cutoff);
  const excluded = comps.filter((c) => ppsf(c) > cutoff);
  return { kept: kept.length ? kept : comps, excluded: kept.length ? excluded : [] };
}

function excludeAbovePercentilePpsf(comps, p) {
  if (!comps.length) return { kept: [], excluded: [] };
  const ppsfValues = comps.map((c) => ppsf(c)).filter((v) => v != null);
  const cutoff = percentile(ppsfValues, p);
  if (cutoff == null) return { kept: comps, excluded: [] };
  const kept = comps.filter((c) => ppsf(c) <= cutoff);
  const excluded = comps.filter((c) => ppsf(c) > cutoff);
  return { kept, excluded };
}

function filterLowPool(comps, subject, maxDistanceMi = LOW_RADIUS_MI) {
  return comps.filter(
    (c) =>
      c.renovated &&
      c.distance != null &&
      c.distance <= maxDistanceMi &&
      sameBedBath(subject, c) &&
      sameStyle(subject, c) &&
      sameEra(subject, c)
  );
}

function filterHighPool(comps, subject, maxDistanceMi = MAX_RADIUS_MI) {
  return comps.filter(
    (c) =>
      c.renovated &&
      c.distance != null &&
      c.distance <= maxDistanceMi &&
      sameStyle(subject, c) &&
      similarSqft(subject, c) &&
      sameEra(subject, c)
  );
}

function distanceSimilarity(distance, market) {
  if (distance == null) return 0;
  const refMi = market === "mansfield" ? LOW_RADIUS_MI : MAX_RADIUS_MI;
  return Math.max(0, 1 - distance / refMi);
}

function sqftSimilarity(subject, comp) {
  if (!subject.sqft || !comp.sqft) return 0.5;
  const diff = Math.abs(comp.sqft - subject.sqft) / subject.sqft;
  return Math.max(0, 1 - diff);
}

function bedBathSimilarity(subject, comp) {
  let score = 0;
  let parts = 0;
  if (subject.beds != null && comp.beds != null) {
    parts++;
    score += subject.beds === comp.beds ? 1 : 0;
  }
  if (subject.baths != null && comp.baths != null) {
    parts++;
    score += subject.baths === comp.baths ? 1 : 0;
  }
  return parts ? score / parts : 0.5;
}

function recencySimilarity(saleDate, asOf = new Date()) {
  const months = monthsSince(saleDate, asOf);
  if (months == null) return 0.5;
  return Math.max(0, 1 - months / LOOKBACK_MONTHS);
}

function buildCompWeights(comps, subject, market, asOf) {
  return comps.map((comp) => {
    const distSim = distanceSimilarity(comp.distance, market);
    const sqftSim = sqftSimilarity(subject, comp);
    const bbSim = bedBathSimilarity(subject, comp);
    const recSim = recencySimilarity(comp.saleDate, asOf);
    const similarity =
      distSim * WEIGHT_DISTANCE +
      sqftSim * WEIGHT_SQFT +
      bbSim * WEIGHT_BED_BATH +
      recSim * WEIGHT_RECENCY;
    return {
      comp,
      address: comp.address ?? comp.parcel_id ?? "Unknown",
      price: comp.price,
      ppsf: ppsf(comp),
      distance: comp.distance,
      similarity_score: Math.round(similarity * 1000) / 1000,
      raw_weight: similarity,
    };
  });
}

function normalizeWeights(rows) {
  const total = rows.reduce((sum, r) => sum + r.raw_weight, 0) || 1;
  return rows.map((r) => ({
    ...r,
    weight: Math.round((r.raw_weight / total) * 10000) / 10000,
  }));
}

function computeConfidence(comps, market, asOf) {
  const ppsfValues = comps.map((c) => ppsf(c)).filter((v) => v != null);
  const variance = populationVariance(ppsfValues);
  const meanPpsf = ppsfValues.length ? ppsfValues.reduce((a, b) => a + b, 0) / ppsfValues.length : 0;
  const cv = meanPpsf > 0 ? Math.sqrt(variance) / meanPpsf : 0;
  let varianceScore = Math.min(45, cv * 120);

  const distances = comps.map((c) => c.distance ?? MAX_RADIUS_MI);
  const avgDistance = distances.reduce((a, b) => a + b, 0) / (distances.length || 1);
  let distancePenalty = avgDistance * 10;

  const monthsList = comps.map((c) => monthsSince(c.saleDate, asOf) ?? LOOKBACK_MONTHS);
  const avgMonths = monthsList.reduce((a, b) => a + b, 0) / (monthsList.length || 1);
  let recencyPenalty = avgMonths * 1.2;

  const extraPenalties = [];

  if (market === "mansfield") {
    distancePenalty *= 1.15;

    if (cv > MANSFIELD_PPSF_CV_THRESHOLD) {
      const cvPenalty = (cv - MANSFIELD_PPSF_CV_THRESHOLD) * 60;
      recencyPenalty += cvPenalty;
      extraPenalties.push({
        type: "ppsf_cv_above_20pct",
        coefficient_of_variation: Math.round(cv * 1000) / 1000,
        penalty: Math.round(cvPenalty * 10) / 10,
      });
    }

    const staleMonths = monthsList.filter((m) => m > MANSFIELD_RECENCY_MONTHS_THRESHOLD);
    if (staleMonths.length) {
      const stalePenalty =
        (staleMonths.reduce((a, b) => a + b - MANSFIELD_RECENCY_MONTHS_THRESHOLD, 0) /
          staleMonths.length) *
        1.2;
      recencyPenalty += stalePenalty;
      extraPenalties.push({
        type: "comps_older_than_6_months",
        count: staleMonths.length,
        penalty: Math.round(stalePenalty * 10) / 10,
      });
    }
  }

  let confidence = 100 - (varianceScore + distancePenalty + recencyPenalty);
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  return {
    pct: confidence,
    penalties: {
      ppsf_variance_score: Math.round(varianceScore * 10) / 10,
      ppsf_coefficient_of_variation: Math.round(cv * 1000) / 1000,
      distance_penalty: Math.round(distancePenalty * 10) / 10,
      recency_penalty: Math.round(recencyPenalty * 10) / 10,
      ppsf_variance: Math.round(variance * 100) / 100,
      avg_distance_mi: Math.round(avgDistance * 1000) / 1000,
      avg_months_since_sale: Math.round(avgMonths * 10) / 10,
      comp_count: comps.length,
      mansfield_extra: extraPenalties,
    },
  };
}

function roundMoney(n) {
  return n == null ? null : Math.round(n);
}

function pickLowPool(comps, subject) {
  const exclusions = [];
  let pool = filterLowPool(comps, subject, LOW_RADIUS_MI);
  let scope = "0.25mi_bed_bath_style_era";

  if (!pool.length) {
    pool = filterLowPool(comps, subject, MAX_RADIUS_MI);
    scope = "0.5mi_bed_bath_style_era_necessity";
    exclusions.push({
      reason: "No comps within 0.25mi — expanded to 0.5mi (Mansfield necessity rule)",
      count: pool.length,
    });
  }

  const { kept, excluded } = excludeTopQuarterPpsf(pool);
  for (const c of excluded) {
    exclusions.push({
      comp: c.address ?? c.parcel_id,
      reason: "Top 25% PPSF outlier (Low ARV pool)",
      ppsf: ppsf(c),
    });
  }

  return { pool: kept, scope, exclusions };
}

function pickHighPool(comps, subject) {
  const exclusions = [];
  let pool = filterHighPool(comps, subject, MAX_RADIUS_MI);
  let scope = "0.5mi_style_sqft20_era20";

  if (!pool.length) {
    pool = comps.filter(
      (c) =>
        c.renovated &&
        sameStyle(subject, c) &&
        similarSqft(subject, c) &&
        sameEra(subject, c)
    );
    scope = "beyond_0.5mi_necessity";
    exclusions.push({
      reason: "No comps within 0.5mi — used beyond 0.5mi (absolute necessity)",
      count: pool.length,
    });
  }

  return { pool, scope, exclusions };
}

/**
 * @param {object} subject - { sqft, beds, baths, yearBuilt, style }
 * @param {object[]} comps - array per spec (+ optional address, parcel_id)
 * @param {object} [options] - { market: 'mansfield' | 'default', asOf: Date }
 */
export function computeArv(subject, comps, options = {}) {
  const market = options.market ?? "mansfield";
  const asOf = options.asOf ?? new Date();
  const allExclusions = [];

  const renovated = comps.filter((c) => c.renovated);
  const notRenovated = comps.filter((c) => !c.renovated);
  for (const c of notRenovated) {
    allExclusions.push({
      comp: c.address ?? c.parcel_id ?? "unknown",
      reason: "Not classified as renovated",
    });
  }

  const withinHalf = renovated.filter((c) => c.distance != null && c.distance <= MAX_RADIUS_MI);
  const beyondHalf = renovated.filter((c) => c.distance == null || c.distance > MAX_RADIUS_MI);
  for (const c of beyondHalf) {
    allExclusions.push({
      comp: c.address ?? c.parcel_id ?? "unknown",
      reason: "Beyond 0.5 miles (held unless absolutely necessary)",
      distance_mi: c.distance,
    });
  }

  const { kept: mansfieldPool, excluded: p90Excluded } = excludeAbovePercentilePpsf(
    withinHalf.length ? withinHalf : renovated,
    0.9
  );
  for (const c of p90Excluded) {
    allExclusions.push({
      comp: c.address ?? c.parcel_id ?? "unknown",
      reason: "Mansfield rule: above 90th percentile PPSF",
      ppsf: ppsf(c),
    });
  }

  const lowPick = pickLowPool(mansfieldPool, subject);
  allExclusions.push(...lowPick.exclusions);

  const highPick = pickHighPool(mansfieldPool, subject);
  allExclusions.push(...highPick.exclusions);

  const lowPpsfValues = lowPick.pool.map((c) => ppsf(c)).filter((v) => v != null);
  const highPpsfValues = highPick.pool.map((c) => ppsf(c)).filter((v) => v != null);
  const bandPpsfValues = mansfieldPool.map((c) => ppsf(c)).filter((v) => v != null);

  const lowPpsf = median(lowPpsfValues);
  let highPpsf = percentile(highPpsfValues, 0.75);
  if (lowPpsf != null && highPpsf != null && highPpsf < lowPpsf) {
    highPpsf = percentile(highPpsfValues, 1) ?? lowPpsf;
  }

  const lowArv = subject.sqft && lowPpsf != null ? roundMoney(lowPpsf * subject.sqft) : null;
  const highArv = subject.sqft && highPpsf != null ? roundMoney(highPpsf * subject.sqft) : null;
  const mostLikelyArv =
    lowArv != null && highArv != null
      ? roundMoney(lowArv * LOW_ARV_WEIGHT + highArv * HIGH_ARV_WEIGHT)
      : null;

  const weightingComps =
    withinHalf.length >= 3 ? withinHalf : mansfieldPool.length ? mansfieldPool : renovated;
  const weightedRows = normalizeWeights(
    buildCompWeights(weightingComps, subject, market, asOf)
  ).sort((a, b) => b.weight - a.weight);

  const confidence = computeConfidence(
    weightingComps.length ? weightingComps : mansfieldPool,
    market,
    asOf
  );

  const compWeighting = weightedRows.map((r) => ({
    address: r.address,
    price: r.price,
    ppsf: r.ppsf == null ? null : Math.round(r.ppsf * 100) / 100,
    distance: r.distance,
    similarity: r.similarity_score,
    weight: r.weight,
  }));

  const topWeighted = compWeighting.slice(0, 3);
  const explanation = buildExplanation({
    allExclusions,
    lowPick,
    highPick,
    topWeighted,
    confidence,
    compCount: comps.length,
    renovatedCount: mansfieldPool.length,
  });

  return {
    low_arv: lowArv,
    high_arv: highArv,
    most_likely_arv: mostLikelyArv,
    confidence,
    renovated_ppsf_band: {
      low: bandPpsfValues.length ? percentile(bandPpsfValues, 0.25) : null,
      high: bandPpsfValues.length ? percentile(bandPpsfValues, 0.75) : null,
    },
    comp_weighting: compWeighting,
    pools: {
      low: lowPick.pool.length,
      low_scope: lowPick.scope,
      high: highPick.pool.length,
      high_scope: highPick.scope,
      renovated_after_filters: mansfieldPool.length,
    },
    exclusions: allExclusions,
    explanation,
    methodology: "arv_engine_v1",
  };
}

function buildExplanation({ allExclusions, lowPick, highPick, topWeighted, confidence, compCount, renovatedCount }) {
  const lines = [];

  const excludedSummary = allExclusions.filter((e) => e.comp);
  if (excludedSummary.length) {
    lines.push(
      `Excluded ${excludedSummary.length} comp(s): not renovated, beyond 0.5mi, above 90th percentile PPSF, or top-25% PPSF outliers in the Low ARV pool.`
    );
  } else {
    lines.push("No comps were excluded by filter rules.");
  }

  if (topWeighted.length) {
    const names = topWeighted.map((c) => `${c.address} (${(c.weight * 100).toFixed(1)}%)`).join(", ");
    lines.push(`Heaviest weights: ${names}.`);
  }

  const p = confidence.penalties;
  lines.push(
    `Confidence ${confidence.pct}% — variance penalty ${p.ppsf_variance_score}, distance penalty ${p.distance_penalty}, recency penalty ${p.recency_penalty} (${p.comp_count} comps, avg distance ${p.avg_distance_mi} mi, avg age ${p.avg_months_since_sale} mo).`
  );

  if (p.mansfield_extra?.length) {
    for (const extra of p.mansfield_extra) {
      lines.push(`Mansfield adjustment: ${extra.type} (+${extra.penalty} recency/variance penalty).`);
    }
  }

  lines.push(
    `Pools: ${lowPick.pool.length} comp(s) for Low ARV (${lowPick.scope}), ${highPick.pool.length} for High ARV (${highPick.scope}); ${renovatedCount} renovated comps after Mansfield filters from ${compCount} input.`
  );

  return lines.join(" ");
}

function money(n) {
  if (n == null) return "N/A";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/**
 * Required output format per spec section 7.
 */
export function formatArvPackage(result) {
  const lines = [];
  lines.push(`Low ARV: ${money(result.low_arv)}`);
  lines.push(`High ARV: ${money(result.high_arv)}`);
  lines.push(`Most Likely ARV: ${money(result.most_likely_arv)}`);
  lines.push(`Confidence: ${result.confidence_engine?.pct ?? result.confidence?.engine_pct ?? result.confidence?.pct ?? 0}%`);
  if (result.confidence?.level) {
    lines.push(`Wholesale trust: ${result.confidence.level} — ${result.confidence.reason ?? ""}`);
  }
  lines.push("");

  const band = result.renovated_ppsf_band;
  if (band?.low != null && band?.high != null) {
    lines.push(
      `Renovated PPSF Band: $${band.low.toFixed(2)}–$${band.high.toFixed(2)}/sqft`
    );
  } else {
    lines.push("Renovated PPSF Band: N/A");
  }
  lines.push("");
  lines.push("Comp Weighting:");
  lines.push("| Address | Price | PPSF | Distance | Similarity | Weight |");
  lines.push("|---------|--------|--------|-----------|------------|--------|");

  for (const c of result.comp_weighting ?? []) {
    const addr = String(c.address ?? "").replace(/\|/g, "/");
    lines.push(
      `| ${addr} | ${money(c.price)} | ${c.ppsf != null ? `$${c.ppsf.toFixed(2)}` : "N/A"} | ${c.distance != null ? `${c.distance.toFixed(3)} mi` : "N/A"} | ${c.similarity?.toFixed(3) ?? "N/A"} | ${(c.weight * 100).toFixed(1)}% |`
    );
  }

  if (!result.comp_weighting?.length) {
    lines.push("| (no comps) | — | — | — | — | — |");
  }

  if (result.explanation) {
    lines.push("");
    lines.push("Explanation:");
    lines.push(result.explanation);
  }

  return lines.join("\n");
}

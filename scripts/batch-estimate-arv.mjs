/**
 * @shared Batch ARV estimates for lead cards or all county improved parcels.
 *
 * Usage:
 *   npm run batch:arv              # lead cards → merge into lead-cards.json
 *   npm run batch:arv:county       # all improved parcels → county-arv-by-parcel.json
 *   node scripts/batch-estimate-arv.mjs --county --merge --county richland
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths } from "../src/core/county-context.mjs";
import { estimateArv, loadArvContext, slimArvResult } from "./estimate-arv.mjs";
import { isVacantLandLead, rankLeads, vacantLandRankSummary } from "./lead-ranking.mjs";

const p = paths();
const LEAD_CARDS = p.leadCards;
const ARV_BY_PARCEL = p.leadArvByParcel;
const COUNTY_ARV_BY_PARCEL = p.countyArvByParcel;

function parseArgs() {
  const radiusIdx = process.argv.indexOf("--radius-mi");
  const monthsIdx = process.argv.indexOf("--months");
  return {
    county: process.argv.includes("--county"),
    merge: process.argv.includes("--merge"),
    full: process.argv.includes("--full"),
    radiusMi: radiusIdx >= 0 ? parseFloat(process.argv[radiusIdx + 1]) : 0.5,
    months: monthsIdx >= 0 ? parseInt(process.argv[monthsIdx + 1], 10) : 18,
  };
}

function summarizeResults(results) {
  const withArv = results.filter((r) => r.arv?.mid != null);
  const trustworthy = results.filter((r) => r.trustworthy_for_wholesale || r.confidence?.trustworthy_for_wholesale);
  const needsReview = results.filter((r) => r.review_required ?? r.confidence?.review_required);
  const byConfidence = { high: 0, medium: 0, low: 0, none: 0 };
  for (const r of results) {
    byConfidence[r.confidence?.level ?? "none"]++;
  }
  return {
    total: results.length,
    with_arv: withArv.length,
    trustworthy_arv: trustworthy.length,
    needs_review: needsReview.length,
    no_arv: results.length - withArv.length,
    confidence: byConfidence,
    arv_mid_median:
      withArv.length > 0
        ? Math.round(
            withArv.map((r) => r.arv.mid).sort((a, b) => a - b)[Math.floor(withArv.length / 2)]
          )
        : null,
  };
}

function isVacantParcel(rec) {
  return (
    rec.likely_vacant_land ||
    (!rec.has_improvements && (rec.building_value == null || rec.building_value === 0))
  );
}

function runBatch(targets, { subjectsByParcel, compPool, spatialIndex, args }) {
  const options = {
    radiusMi: args.radiusMi,
    months: args.months,
    spatialIndex,
    parcelLookup: subjectsByParcel,
    includeComps: args.full,
  };

  const results = [];
  const byParcelOut = {};
  let skipped = 0;
  let skippedVacant = 0;

  for (const target of targets) {
    const parcelId = target.parcel_id;
    const subject = subjectsByParcel.get(parcelId);
    const vacant = target.likely_vacant_land != null ? isVacantLandLead(target) : isVacantParcel(subject ?? target);

    if (vacant) {
      skippedVacant++;
      const empty = {
        parcel_id: parcelId,
        skipped: "vacant_land",
        arv: null,
        confidence: { level: "none", score: 0, reason: "Vacant land — ARV not applicable" },
      };
      results.push(empty);
      byParcelOut[parcelId] = empty;
      continue;
    }

    if (!subject?.lat || !subject?.lon) {
      skipped++;
      const empty = {
        parcel_id: parcelId,
        comp_count: 0,
        confidence: { level: "none", score: 0, reason: "No coordinates in comp index" },
        arv: null,
        radius_mi: args.radiusMi,
        lookback_months: args.months,
      };
      results.push(empty);
      byParcelOut[parcelId] = empty;
      continue;
    }

    const result = estimateArv(subject, compPool, options);
    const slim = args.full ? result : slimArvResult(result);
    results.push(slim);
    byParcelOut[parcelId] = slim;
  }

  return { results, byParcelOut, skipped, skippedVacant };
}

function main() {
  const args = parseArgs();
  const ctx = loadArvContext();
  console.error(`Loading ARV context...`);
  console.error(`  Subjects:     ${ctx.subjects.length}`);
  console.error(`  Comp pool:    ${ctx.compPool.length}${ctx.salesEvents ? " (sales events)" : " (parcel index fallback)"}`);

  let targets;
  let outPath;
  let label;

  if (args.county) {
    targets = ctx.subjects.filter((r) => !isVacantParcel(r));
    outPath = COUNTY_ARV_BY_PARCEL;
    label = "county improved parcels";
  } else {
    if (!fs.existsSync(LEAD_CARDS)) {
      throw new Error(`Missing ${LEAD_CARDS}. Run: npm run build:lead-cards`);
    }
    targets = JSON.parse(fs.readFileSync(LEAD_CARDS, "utf8")).cards ?? [];
    outPath = ARV_BY_PARCEL;
    label = "lead cards";
  }

  console.error(`Estimating ARV for ${targets.length} ${label}...`);
  const started = Date.now();
  const { results, byParcelOut, skipped, skippedVacant } = runBatch(targets, { ...ctx, args });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const stats = summarizeResults(results);

  const output = {
    generated_at: new Date().toISOString(),
    scope: args.county ? "county" : "lead_cards",
    params: { radius_mi: args.radiusMi, lookback_months: args.months },
    comp_pool: ctx.salesEvents ? "sales-events" : "comp-index",
    stats: { ...stats, skipped_no_coords: skipped, skipped_vacant_land: skippedVacant, elapsed_sec: parseFloat(elapsed) },
    by_parcel: byParcelOut,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  if (args.merge && !args.county) {
    const leadCards = JSON.parse(fs.readFileSync(LEAD_CARDS, "utf8"));
    const cards = leadCards.cards ?? [];
    for (const card of cards) {
      card.arv = byParcelOut[card.parcel_id] ?? null;
    }
    leadCards.cards = rankLeads(cards);
    leadCards.arv_stats = stats;
    leadCards.arv_generated_at = output.generated_at;
    leadCards.ranking = {
      sorted_by: "rank_score desc",
      vacant_land_deprioritized: true,
      vacant_land: vacantLandRankSummary(leadCards.cards),
    };
    fs.writeFileSync(LEAD_CARDS, JSON.stringify(leadCards, null, 2));
  }

  console.error("");
  console.error("Batch ARV complete");
  console.error(`  Scope:          ${output.scope}`);
  console.error(`  Processed:      ${targets.length} (${skippedVacant} vacant skipped)`);
  console.error(`  With ARV:       ${stats.with_arv}`);
  console.error(`  Trustworthy:    ${stats.trustworthy_arv}`);
  console.error(`  Needs review:   ${stats.needs_review}`);
  console.error(`  No ARV:         ${stats.no_arv}`);
  console.error(`  No coordinates: ${skipped}`);
  console.error(`  Median mid ARV: ${stats.arv_mid_median ?? "n/a"}`);
  console.error(`  Elapsed:        ${elapsed}s`);
  console.error(`  Wrote ${outPath}`);
  if (args.merge && !args.county) console.error(`  Merged into ${LEAD_CARDS}`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

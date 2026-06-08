/**
 * Weighted ARV CLI — uses canonical src/arv/arvEngine.js
 *
 * Usage:
 *   npm run estimate:arv:weighted -- 027-04-044-07-000
 *   npm run estimate:arv:weighted -- 027-04-044-07-000 --format table
 */

import path from "path";
import { fileURLToPath } from "url";
import { computeArv, formatArvPackage } from "../src/arv/arvEngine.js";
import { buildCompsForSubject, subjectFromParcel } from "../src/arv/countyAdapter.js";
import { getNearbyRecords, loadArvContext } from "./estimate-arv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const parcelIdx = process.argv.indexOf("--parcel");
  const formatIdx = process.argv.indexOf("--format");
  const monthsIdx = process.argv.indexOf("--months");
  const positional = process.argv.find((a) => /^\d{3}-\d{2}-\d{3}-\d{2}-\d{3}$/.test(a));
  return {
    parcelId:
      parcelIdx >= 0 ? process.argv[parcelIdx + 1] : positional ?? "027-04-044-07-000",
    format: formatIdx >= 0 ? process.argv[formatIdx + 1] : "json",
    months: monthsIdx >= 0 ? parseInt(process.argv[monthsIdx + 1], 10) : 18,
  };
}

export function estimateWeightedArv(subjectParcel, compPool, options = {}) {
  const months = options.months ?? 18;
  const maxMi = options.maxMi ?? 0.5;
  const pool = options.spatialIndex
    ? getNearbyRecords(options.spatialIndex, subjectParcel.lat, subjectParcel.lon, maxMi)
    : compPool;

  const comps = buildCompsForSubject(subjectParcel, pool, options.parcelLookup, { months, maxMi });
  const subject = subjectFromParcel(subjectParcel);
  const result = computeArv(subject, comps, { market: options.market ?? "mansfield" });

  return {
    parcel_id: subjectParcel.parcel_id,
    address: subjectParcel.address,
    subject,
    ...result,
    arv: result.low_arv != null
      ? {
          low: result.low_arv,
          mid: result.most_likely_arv,
          high: result.high_arv,
        }
      : null,
    marketing_arv: result.most_likely_arv != null
      ? { price: result.most_likely_arv, basis: "weighted_0.6_low_0.4_high" }
      : null,
    confidence_legacy: {
      level: result.confidence.pct >= 70 ? "high" : result.confidence.pct >= 40 ? "medium" : "low",
      score: result.confidence.pct / 100,
      trustworthy_for_wholesale: result.confidence.pct >= 40,
      review_required: result.confidence.pct < 70,
      reason: result.explanation,
    },
  };
}

function main() {
  const args = parseArgs();
  const { subjectsByParcel, compPool, spatialIndex } = loadArvContext();
  const parcel = subjectsByParcel.get(args.parcelId);
  if (!parcel) {
    console.error(`Parcel not found: ${args.parcelId}`);
    process.exit(1);
  }

  const result = estimateWeightedArv(parcel, compPool, {
    months: args.months,
    spatialIndex,
    parcelLookup: subjectsByParcel,
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

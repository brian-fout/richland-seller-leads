/**
 * Test ARV engine against known Mansfield properties + condition classification.
 *
 * Usage: npm run test:arv
 */

import { paths } from "../src/core/county-context.mjs";
import { loadAgentCalibration } from "../src/core/agent-feedback.mjs";
import { computeArv, formatArvPackage } from "../src/arv/arvEngine.js";
import { buildCompsForSubject, subjectFromParcel } from "../src/arv/countyAdapter.js";
import {
  hasStrongRetailPriceSignals,
  isPoorConditionOrGrade,
  isRenovatedSale,
  resolveSaleTimeCondition,
} from "../src/counties/richland/condition.mjs";
import { getNearbyRecords, loadArvContext } from "./estimate-arv.mjs";

/**
 * Mansfield regression fixtures — conservative known ranges.
 * Widen ranges when comps pool shifts after CAMA refresh.
 */
const MANSFIELD_OWNED_TESTS = [
  {
    parcel_id: "027-04-044-07-000",
    label: "252 N Bowman St",
    known_arv_range: { low: 48000, high: 70000 },
    notes: "996 sqft D+; May 2024 investor purchase $35k; hand comps ~$62k mid",
  },
  {
    parcel_id: "021-17-060-10-000",
    label: "561 W Woodcrest Dr",
    known_arv_range: { low: 120000, high: 190000 },
    notes: "960 sqft AV/C-; suburban Mansfield — sanity check mid-market ARV",
  },
  {
    parcel_id: "027-04-053-05-000",
    label: "520 Lida St",
    known_arv_range: { low: 45000, high: 90000 },
    notes: "Distress-adjacent Mansfield lead card parcel — wide conservative band",
  },
  {
    parcel_id: "027-06-022-03-000",
    label: "135 S Diamond St",
    known_arv_range: { low: 40000, high: 120000 },
    notes: "Multi-source distress lead — ARV may be null or wide; bounds only if present",
    allow_null: true,
  },
];

const CONDITION_TESTS = [
  {
    label: "VP parcel strong flip price overrides poor snapshot",
    price: 63600,
    ppsf: 70.8,
    saleToAssessed: 0.82,
    condition: "VP",
    grade: "D0",
    expectRenovated: true,
  },
  {
    label: "VP low as-is sale stays distressed",
    price: 9500,
    ppsf: 6.7,
    saleToAssessed: 0.16,
    condition: "VP",
    grade: "D0",
    expectRenovated: false,
  },
  {
    label: "AV average sale at retail ppsf",
    price: 62000,
    ppsf: 62,
    saleToAssessed: 1.1,
    condition: "AV",
    grade: "C0",
    expectRenovated: true,
  },
  {
    label: "FR grade with thin price not retail",
    price: 22000,
    ppsf: 18,
    saleToAssessed: 0.4,
    condition: "FR",
    grade: "D0",
    expectRenovated: false,
  },
];

function loadCalibrationTests() {
  const cal = loadAgentCalibration(paths().agentCalibration);
  const tests = [];
  for (const row of cal.parcels ?? []) {
    const range =
      row.agent_arv_range ??
      (row.agent_arv != null ? { low: row.agent_arv * 0.9, high: row.agent_arv * 1.1 } : null);
    if (!range?.low || !range?.high) continue;
    tests.push({
      parcel_id: row.parcel_id,
      label: row.address ?? row.parcel_id,
      known_arv_range: range,
      notes: `Agent calibration (${row.updated_at?.slice(0, 10) ?? "?"})`,
      source: "agent_calibration",
    });
  }
  return tests;
}

function inRange(value, range) {
  if (value == null) return false;
  return value >= range.low && value <= range.high;
}

function runConditionTests() {
  let passed = 0;
  let failed = 0;

  console.log("\nCondition classification — sale-time overrides\n");
  console.log("=".repeat(60));

  for (const test of CONDITION_TESTS) {
    const renovated = isRenovatedSale(
      test.price,
      test.ppsf,
      test.saleToAssessed,
      test.condition,
      test.grade
    );
    const ctx = resolveSaleTimeCondition({
      price: test.price,
      ppsf: test.ppsf,
      saleToAssessed: test.saleToAssessed,
      condition: test.condition,
      grade: test.grade,
    });
    const ok = renovated === test.expectRenovated;

    console.log(`\n${test.label}`);
    console.log(
      `  $${test.price.toLocaleString()} @ $${test.ppsf}/sf | ${test.condition}/${test.grade}`
    );
    console.log(
      `  flip_override=${ctx.flip_price_override} effective_poor=${ctx.effective_poor} → renovated=${renovated}`
    );
    console.log(ok ? "  ✓ pass" : `  ✗ expected renovated=${test.expectRenovated}`);
    if (ok) passed++;
    else failed++;
  }

  const poor = isPoorConditionOrGrade("VP", "D0");
  const strong = hasStrongRetailPriceSignals(63600, 70.8, 0.82);
  if (poor && strong) passed++;
  else {
    console.log("\n✗ VP/D0 poor + strong price signal combo");
    failed++;
  }

  console.log(`\nCondition tests: ${passed} passed, ${failed} failed`);
  return failed;
}

function runArvTests() {
  const { subjectsByParcel, compPool, spatialIndex } = loadArvContext();
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  console.log("ARV Engine — Mansfield regression\n");
  console.log("=".repeat(60));

  const tests = [...MANSFIELD_OWNED_TESTS];
  for (const t of loadCalibrationTests()) {
    if (!tests.some((x) => x.parcel_id === t.parcel_id)) tests.push(t);
  }

  for (const test of tests) {
    const parcel = subjectsByParcel.get(test.parcel_id);
    if (!parcel) {
      console.error(`SKIP: parcel not found ${test.parcel_id}`);
      skipped++;
      continue;
    }

    const pool = getNearbyRecords(spatialIndex, parcel.lat, parcel.lon, 0.5);
    const comps = buildCompsForSubject(parcel, pool, subjectsByParcel, { months: 18, maxMi: 0.5 });
    const subject = subjectFromParcel(parcel);
    const result = computeArv(subject, comps, { market: "mansfield" });

    const ml = result.most_likely_arv;
    const ok = test.allow_null && ml == null ? true : inRange(ml, test.known_arv_range);

    console.log(`\n${test.label} (${test.parcel_id})`);
    if (ml != null) console.log(formatArvPackage(result));
    else console.log("  (no ARV — insufficient comps)");
    console.log("");
    console.log(
      `Known range: $${test.known_arv_range.low.toLocaleString()}–$${test.known_arv_range.high.toLocaleString()}`
    );
    console.log(`Notes: ${test.notes}`);
    console.log(
      ok
        ? `✓ Most Likely ARV $${ml?.toLocaleString() ?? "N/A"} within expected bounds`
        : `✗ Most Likely ARV $${ml?.toLocaleString() ?? "N/A"} OUTSIDE expected bounds`
    );

    if (ok) passed++;
    else failed++;
    console.log("-".repeat(60));
  }

  console.log(`\nARV tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed + skipped > 0 && failed > 0 ? failed : failed;
}

function main() {
  const condFailed = runConditionTests();
  const arvFailed = runArvTests();
  const totalFailed = condFailed + arvFailed;
  console.log(`\nTotal: ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();

/**
 * Test ARV engine against known Mansfield properties.
 *
 * Usage: npm run test:arv
 */

import { paths } from "../src/core/county-context.mjs";
import { loadAgentCalibration } from "../src/core/agent-feedback.mjs";
import { computeArv, formatArvPackage } from "../src/arv/arvEngine.js";
import { buildCompsForSubject, subjectFromParcel } from "../src/arv/countyAdapter.js";
import { getNearbyRecords, loadArvContext } from "./estimate-arv.mjs";

/** Properties you own / know ARV range for — add parcels and expected ranges here. */
const MANSFIELD_OWNED_TESTS = [
  {
    parcel_id: "027-04-044-07-000",
    label: "252 N Bowman St",
    known_arv_range: { low: 48000, high: 65000 },
    notes: "996 sqft VP/D-; May 2024 investor purchase $35k; hand comps ~$62k mid",
  },
];

function loadCalibrationTests() {
  const cal = loadAgentCalibration(paths().agentCalibration);
  const tests = [];
  for (const row of cal.parcels ?? []) {
    const range = row.agent_arv_range ?? (row.agent_arv != null ? { low: row.agent_arv * 0.9, high: row.agent_arv * 1.1 } : null);
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

function main() {
  const { subjectsByParcel, compPool, spatialIndex } = loadArvContext();
  let passed = 0;
  let failed = 0;

  console.log("ARV Engine — Mansfield owned-property tests\n");
  console.log("=".repeat(60));

  const tests = [...MANSFIELD_OWNED_TESTS];
  for (const t of loadCalibrationTests()) {
    if (!tests.some((x) => x.parcel_id === t.parcel_id)) tests.push(t);
  }

  for (const test of tests) {
    const parcel = subjectsByParcel.get(test.parcel_id);
    if (!parcel) {
      console.error(`SKIP: parcel not found ${test.parcel_id}`);
      failed++;
      continue;
    }

    const pool = getNearbyRecords(spatialIndex, parcel.lat, parcel.lon, 0.5);
    const comps = buildCompsForSubject(parcel, pool, subjectsByParcel, { months: 18, maxMi: 0.5 });
    const subject = subjectFromParcel(parcel);
    const result = computeArv(subject, comps, { market: "mansfield" });

    const ml = result.most_likely_arv;
    const ok = inRange(ml, test.known_arv_range);

    console.log(`\n${test.label} (${test.parcel_id})`);
    console.log(formatArvPackage(result));
    console.log("");
    console.log(`Known range: $${test.known_arv_range.low.toLocaleString()}–$${test.known_arv_range.high.toLocaleString()}`);
    console.log(`Notes: ${test.notes}`);
    console.log(
      ok
        ? `✓ Most Likely ARV $${ml?.toLocaleString()} is within known range`
        : `✗ Most Likely ARV $${ml?.toLocaleString() ?? "N/A"} is OUTSIDE known range`
    );

    if (ok) passed++;
    else failed++;
    console.log("-".repeat(60));
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

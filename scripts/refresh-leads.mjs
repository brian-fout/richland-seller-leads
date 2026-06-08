/**
 * @shared One-command lead refresh: link → profiles → cards → ARV merge.
 *
 * Usage:
 *   npm run refresh:leads
 *   npm run refresh:leads -- --skip-profiles   # faster if GIS profiles cached
 *   npm run refresh:leads -- --skip-arv        # cards only, no ARV merge
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const STEPS = [
  { label: "link:leads", script: "link-leads.mjs", skipFlag: null },
  { label: "enrich:property-profiles", script: "enrich-property-profiles.mjs", skipFlag: "--skip-profiles" },
  { label: "build:lead-cards", script: "build-lead-cards.mjs", skipFlag: null },
  { label: "batch:arv --merge", script: "batch-estimate-arv.mjs", args: ["--merge"], skipFlag: "--skip-arv" },
];

function sharedCountyArgs() {
  const idx = process.argv.indexOf("--county");
  if (idx >= 0 && process.argv[idx + 1]) return ["--county", process.argv[idx + 1]];
  return [];
}

function runStep(step) {
  const scriptPath = path.join(__dirname, step.script);
  const args = [scriptPath, ...(step.args ?? []), ...sharedCountyArgs()];
  console.error(`\n=== ${step.label} ===\n`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nFailed: ${step.label} (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  const argv = new Set(process.argv.slice(2));
  console.error("Richland lead refresh pipeline");
  console.error("  Steps: link → property-profiles → lead-cards → batch:arv --merge");

  for (const step of STEPS) {
    if (step.skipFlag && argv.has(step.skipFlag)) {
      console.error(`\n=== ${step.label} (skipped) ===`);
      continue;
    }
    runStep(step);
  }

  console.error("\nLead refresh complete.");
  console.error("  Query: npm run query:leads -- --county richland --city Mansfield --limit 10");
}

main();

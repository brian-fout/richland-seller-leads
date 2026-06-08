/**
 * @county richland — One-command CAMA refresh: download → import → sales events.
 *
 * Usage:
 *   npm run refresh:cama
 *   npm run refresh:cama -- --skip-download
 *   npm run refresh:cama -- --county richland
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const STEPS = [
  { label: "download:auditor-cama", script: "download-auditor-cama.mjs", skipFlag: "--skip-download" },
  { label: "import:auditor-cama", script: "import-auditor-cama.mjs" },
  { label: "build:sales-events", script: "build-sales-events.mjs" },
];

function sharedCountyArgs() {
  const idx = process.argv.indexOf("--county");
  if (idx >= 0 && process.argv[idx + 1]) return ["--county", process.argv[idx + 1]];
  return [];
}

function runStep(step) {
  const scriptPath = path.join(__dirname, step.script);
  const args = [scriptPath, ...sharedCountyArgs()];
  console.error(`\n=== ${step.label} ===\n`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nFailed: ${step.label} (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  const argv = new Set(process.argv.slice(2));
  console.error("CAMA refresh pipeline");
  console.error("  Steps: download → import → sales-events");

  for (const step of STEPS) {
    if (step.skipFlag && argv.has(step.skipFlag)) {
      console.error(`\n=== ${step.label} (skipped) ===`);
      continue;
    }
    runStep(step);
  }

  console.error("\nCAMA refresh complete.");
  console.error("  Optional: npm run pull:county-parcels  (refresh GIS comp index)");
  console.error("  Next: npm run refresh:leads");
}

main();

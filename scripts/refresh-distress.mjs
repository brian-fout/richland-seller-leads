/**
 * @shared Distress data pipeline: scrape → enrich parcel IDs → link leads.
 *
 * Usage:
 *   npm run refresh:distress
 *   npm run refresh:distress -- --skip-scrape        # enrich + link only
 *   npm run refresh:distress -- --skip-clerk         # skip clerk enrichment
 *   npm run refresh:distress -- --skip-probate-scrape  # skip headed probate scrape (default)
 *   npm run refresh:distress -- --clerk-details        # clerk case detail pages (needs clerk-cookies.json)
 *   npm run refresh:distress -- --county richland
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { findLatestTaxLienPdf } from "../src/core/tax-lien-discovery.mjs";
import { paths } from "../src/core/county-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const SCRAPE_STEPS = [
  { label: "parse:tax-lien-list", script: "parse-tax-lien-list.mjs", optional: true, needsPdf: true },
  { label: "scrape:lis-pendens", script: "scrape-lis-pendens.mjs" },
  { label: "scrape:pre-foreclosure", script: "scrape-pre-foreclosure.mjs" },
  { label: "scrape:evictions", script: "scrape-evictions.mjs" },
  { label: "scrape:code-violations", script: "scrape-code-violations.mjs" },
  {
    label: "scrape:probate-estates",
    script: "scrape-probate-estates.mjs",
    skipFlag: "--skip-probate-scrape",
    skipByDefault: true,
    note: "CAPTCHA — run manually: npm run scrape:probate-estates",
  },
];

const ENRICH_STEPS = [
  { label: "enrich:lis-pendens", script: "enrich-lis-pendens-parcels.mjs" },
  { label: "enrich:probate-addresses", script: "enrich-probate-addresses.mjs" },
  { label: "enrich:parcel-ids", script: "enrich-parcel-ids.mjs" },
  { label: "enrich:clerk-foreclosures", script: "enrich-clerk-foreclosures.mjs", skipFlag: "--skip-clerk" },
  { label: "link:leads", script: "link-leads.mjs" },
];

function sharedCountyArgs() {
  const idx = process.argv.indexOf("--county");
  if (idx >= 0 && process.argv[idx + 1]) return ["--county", process.argv[idx + 1]];
  return [];
}

function runStep(step, extraArgs = []) {
  const scriptPath = path.join(__dirname, step.script);
  const args = [scriptPath, ...extraArgs, ...sharedCountyArgs()];
  console.error(`\n=== ${step.label} ===\n`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nFailed: ${step.label} (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

function clerkEnrichArgs(argv) {
  if (argv.has("--clerk-details")) return [];
  return ["--no-details"];
}

function main() {
  const argv = new Set(process.argv.slice(2));
  const skipScrape = argv.has("--skip-scrape");
  const p = paths();

  console.error("Distress refresh pipeline");
  console.error(`  Data root: ${p.dataRoot}`);
  console.error("  Flow: scrape → enrich parcels → link:leads");

  if (!skipScrape) {
    const pdf = findLatestTaxLienPdf(p.dataRoot);
    for (const step of SCRAPE_STEPS) {
      const skipStep =
        (step.skipFlag && argv.has(step.skipFlag)) || (step.skipByDefault && !argv.has("--with-probate-scrape"));
      if (skipStep) {
        console.error(`\n=== ${step.label} (skipped) ===`);
        if (step.note) console.error(`  ${step.note}`);
        continue;
      }
      if (step.needsPdf && !pdf) {
        console.error(`\n=== ${step.label} (skipped — no tax lien PDF in inbox) ===`);
        console.error(`  Drop PDF in ${path.join(p.dataRoot, "inbox")}`);
        continue;
      }
      const extra = step.needsPdf && pdf ? [pdf.path] : [];
      runStep(step, extra);
    }
  } else {
    console.error("\n=== scrape phase (skipped) ===");
  }

  for (const step of ENRICH_STEPS) {
    if (step.skipFlag && argv.has(step.skipFlag)) {
      console.error(`\n=== ${step.label} (skipped) ===`);
      continue;
    }
    const extra =
      step.label === "enrich:clerk-foreclosures" ? clerkEnrichArgs(argv) : [];
    runStep(step, extra);
  }

  console.error("\nDistress refresh complete.");
  console.error("  Next: npm run refresh:leads");
}

main();

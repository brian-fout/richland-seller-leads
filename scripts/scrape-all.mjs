/**
 * Run unattended data collection scripts (no SQLite).
 *
 * Attended sources (probate CAPTCHA, clerk foreclosures) are documented but not run here.
 * After this, run: npm run refresh:distress -- --skip-scrape  (if enrich-only)
 *   or npm run refresh:distress  (full pipeline including link)
 *
 * Usage: npm run scrape:all
 *        npm run scrape:all -- --county richland
 */

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { findLatestTaxLienPdf } from "../src/core/tax-lien-discovery.mjs";
import { paths } from "../src/core/county-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function sharedCountyFlag() {
  const idx = process.argv.indexOf("--county");
  if (idx >= 0 && process.argv[idx + 1]) return ` --county ${process.argv[idx + 1]}`;
  return "";
}

function run(label, cmd) {
  console.error(`\n========== ${label} ==========\n`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

const countyFlag = sharedCountyFlag();
const p = paths();
const pdf = findLatestTaxLienPdf(p.dataRoot);

try {
  if (pdf) {
    run("Tax liens (delinquent land list PDF)", `node scripts/parse-tax-lien-list.mjs "${pdf.path}"${countyFlag}`);
  } else {
    console.error("\n========== Tax liens ==========");
    console.error(`  Skipped — no prosecutor/delinquent PDF in ${p.dataRoot} or inbox/`);
    console.error("  Drop PDF in data/counties/richland/inbox/ then re-run");
  }

  run("Early pre-foreclosure (Recorder lis pendens)", `node scripts/scrape-lis-pendens.mjs${countyFlag}`);
  run("Sheriff auctions (late stage / RealAuction)", `node scripts/scrape-pre-foreclosure.mjs${countyFlag}`);
  run("Evictions (Mansfield Municipal Court)", `node scripts/scrape-evictions.mjs${countyFlag}`);
  run("Code violations (Mansfield Building & Codes)", `node scripts/scrape-code-violations.mjs${countyFlag}`);

  console.error("\n========== Clerk foreclosures (CAPTCHA — run separately) ==========");
  console.error("  npm run scrape:clerk:session");
  console.error("  npm run scrape:clerk-foreclosures");

  console.error("\n========== Probate estates (CAPTCHA — run separately) ==========");
  console.error("  npm run scrape:probate-estates");

  console.error("\n========== Done ==========");
  console.error(`Output files are in ${p.dataRoot}`);
  console.error("Next: npm run refresh:distress -- --skip-scrape");
} catch (err) {
  console.error("\nScrape-all failed:", err.message);
  process.exit(1);
}

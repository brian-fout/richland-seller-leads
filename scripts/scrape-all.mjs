/**
 * Run all data collection scripts (no SQLite).
 *
 * Unattended: tax liens, lis pendens, sheriff auctions.
 * Attended: probate (CAPTCHA per search — browser opens at the end).
 *
 * Usage: npm run scrape:all
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function run(label, cmd) {
  console.error(`\n========== ${label} ==========\n`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

const defaultPdf = "c:/Users/brian/Downloads/Prosecutor List 10-21-2025.pdf";
const hasPdf = fs.existsSync(defaultPdf);

try {
  if (hasPdf) {
    run("Tax liens (delinquent land list PDF)", "node scripts/parse-tax-lien-list.mjs");
  } else {
    console.error("\n========== Tax liens ==========");
    console.error(`  Skipped — PDF not found at ${defaultPdf}`);
    console.error("  Run manually: node scripts/parse-tax-lien-list.mjs [path-to-pdf]");
  }

  run("Early pre-foreclosure (Recorder lis pendens)", "node scripts/scrape-lis-pendens.mjs");

  run("Sheriff auctions (late stage / RealAuction)", "node scripts/scrape-pre-foreclosure.mjs");

  run("Evictions (Mansfield Municipal Court)", "node scripts/scrape-evictions.mjs");

  run("Code violations (Mansfield Building & Codes)", "node scripts/scrape-code-violations.mjs");

  run("Probate estates (CaseLook — solve CAPTCHA in browser)", "node scripts/scrape-probate-estates.mjs");

  console.error("\n========== Done ==========");
  console.error("Output files are in data/");
  console.error("Clerk foreclosure filings (one-time CAPTCHA): npm run scrape:clerk:session");
} catch (err) {
  console.error("\nScrape-all failed:", err.message);
  process.exit(1);
}

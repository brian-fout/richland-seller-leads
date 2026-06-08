/**
 * Scrape Richland County Clerk of Courts civil foreclosure filings (CourtView eAccess).
 *
 * Requires a one-time CAPTCHA session (saved cookies) or --interactive mode.
 *
 * Usage:
 *   npm run scrape:clerk:session              # save cookies first (one time)
 *   npm run scrape:clerk-foreclosures -- --interactive
 *   npm run scrape:clerk-foreclosures -- --from 01/01/2026 --to 03/31/2026
 *   node scripts/scrape-clerk-foreclosures.mjs --captcha=abcd --from 01/01/2026 --to 01/31/2026
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { BASE_URL, ensureClerkSession } from "./clerk-session.mjs";
import {
  openSearchArea,
  submitCaseTypeSearch,
  collectAllSearchResults,
  countResultsHint,
  isForeclosureRecord,
} from "./clerk-search.mjs";
import {
  incrementalFromUsDate,
  markSourceRun,
  parseUsDate,
  fmtUsDate,
  monthOutputExists,
  monthOutputHasRecords,
  loadMonthRecords,
  writeMonthOutputs,
  writeCanonicalFromMonths,
} from "./scrape-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const SOURCE_ID = "clerk-foreclosures";
const DEBUG_HTML = path.join(DATA_DIR, "_clerk-last-results.html");
const MONTH_RULE = "────────────────────────────────────────";

async function pauseBeforeClose(options, { reason, seconds = 60 } = {}) {
  if (!options.headed) return;
  console.error(`\n${reason}`);
  console.error(`Browser will stay open for ${seconds} seconds (close it anytime)…`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function monthAlreadySaved(sourceId, year, month, force) {
  if (force) return false;
  return monthOutputHasRecords(sourceId, year, month);
}

function parseArgs() {
  const fromIdx = process.argv.indexOf("--from");
  const toIdx = process.argv.indexOf("--to");
  const headless = process.argv.includes("--headless");

  const base = {
    interactive: process.argv.includes("--interactive") || !headless,
    headed: !headless || process.argv.includes("--headed") || process.argv.includes("--interactive"),
    force: process.argv.includes("--force"),
    includeAllCivil: process.argv.includes("--all-civil"),
  };

  if (fromIdx >= 0 && toIdx >= 0) {
    return { ...base, mode: "range", from: process.argv[fromIdx + 1], to: process.argv[toIdx + 1] };
  }
  return { ...base, mode: "incremental" };
}

function buildMonthlyPeriods(options) {
  const today = new Date();
  const from =
    options.mode === "range" ? parseUsDate(options.from) : parseUsDate(incrementalFromUsDate(SOURCE_ID));
  const to = options.mode === "range" ? parseUsDate(options.to) : today;

  if (!from || !to) throw new Error("Invalid date range");

  const periods = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  const endMonth = new Date(to.getFullYear(), to.getMonth(), 1);

  while (cursor <= endMonth) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const rangeStart = monthStart < from ? from : monthStart;
    const rangeEnd = monthEnd > to ? to : monthEnd;
    periods.push({
      year: cursor.getFullYear(),
      month: cursor.getMonth() + 1,
      label: `${cursor.getMonth() + 1}/${cursor.getFullYear()}`,
      from: fmtUsDate(rangeStart),
      to: fmtUsDate(rangeEnd),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return periods;
}

function logMonthHeader(label) {
  console.error("");
  console.error(MONTH_RULE);
  console.error(`  ${label}`);
  console.error(MONTH_RULE);
}

async function searchForeclosuresForPeriod(page, period, options) {
  await openSearchArea(page, BASE_URL);
  await submitCaseTypeSearch(page, period.from, period.to, {
    includeAllCivil: options.includeAllCivil,
  });

  const html = await page.content();
  const body = await page.innerText("body");
  fs.writeFileSync(DEBUG_HTML, html);

  const expected = countResultsHint(body, html);
  let records = await collectAllSearchResults(page);

  if (!options.includeAllCivil) {
    records = records.filter(isForeclosureRecord);
  }

  if (expected != null && expected > 0 && records.length === 0) {
    console.error(`  WARNING: page hints ${expected} result(s) but parser got 0 — see ${DEBUG_HTML}`);
  }

  return records;
}

async function scrapeClerkForeclosures(periods, options) {
  const browser = await chromium.launch({
    headless: !options.headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const runRecords = [];
  const allRecords = [];
  let failed = false;
  let skippedMonths = 0;

  try {
    console.error("Opening Clerk of Courts eAccess…");
    await ensureClerkSession(page, context, { interactive: options.interactive });

    for (const period of periods) {
      logMonthHeader(period.label);

      if (monthAlreadySaved(SOURCE_ID, period.year, period.month, options.force)) {
        const saved = loadMonthRecords(SOURCE_ID, period.year, period.month);
        allRecords.push(...saved);
        skippedMonths += 1;
        console.error(`Skipping — already saved (${saved.length} case(s))`);
        continue;
      }

      if (!options.force && monthOutputExists(SOURCE_ID, period.year, period.month)) {
        console.error("Re-scraping — previous run saved 0 cases (bad/empty output)");
      }

      console.error(`Searching civil foreclosures filed ${period.from} – ${period.to}…`);
      const records = await searchForeclosuresForPeriod(page, period, options);
      console.error(`  ${records.length} foreclosure case(s)`);

      writeMonthOutputs(SOURCE_ID, period.year, period.month, records);
      markSourceRun(SOURCE_ID, {
        last_from_date: periods[0].from,
        last_to_date: period.to,
      });

      const { canonical, canonicalJson } = writeCanonicalFromMonths(SOURCE_ID, (r) => r.case_number);
      console.error(`  Canonical total: ${canonical.length} (${canonicalJson})`);

      runRecords.push(...records);
      allRecords.push(...records);
    }

    if (runRecords.length === 0 && skippedMonths === periods.length) {
      console.error(
        `\nNothing scraped — all ${periods.length} month(s) already on disk. Use --force to re-run.`
      );
      await pauseBeforeClose(options, {
        reason: "All months were skipped.",
        seconds: 20,
      });
    }

    return { runRecords, allRecords };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (failed) {
      await pauseBeforeClose(options, {
        reason: "Scrape failed — check the browser and terminal error above.",
        seconds: 60,
      });
    }
    await browser.close();
  }
}

async function main() {
  const options = parseArgs();
  const periods = buildMonthlyPeriods(options);

  if (periods.length === 0) {
    console.error("No periods to search.");
    return;
  }

  console.error(
    `Clerk foreclosure search: ${periods.length} month(s) from ${periods[0].label} to ${periods[periods.length - 1].label}`
  );
  if (options.interactive) {
    console.error("Interactive mode: solve CAPTCHA in the browser if prompted.");
  }

  const { runRecords } = await scrapeClerkForeclosures(periods, options);
  const { canonical, canonicalJson, canonicalCsv } = writeCanonicalFromMonths(
    SOURCE_ID,
    (r) => r.case_number
  );

  console.error(`Fetched this run:  ${runRecords.length}`);
  console.error(`Canonical total:   ${canonical.length}`);
  console.error(`Wrote ${canonicalJson}`);
  console.error(`Wrote ${canonicalCsv}`);
}

main().catch(async (err) => {
  console.error("\nERROR:", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

/**
 * Scrape Richland County Probate Court estate filings (CaseLook).
 *
 * Searches by file date for Estate (PE) cases only. CaseLook requires a CAPTCHA
 * on every search. Default is attended mode: headed browser, one day at a time.
 *
 * Usage:
 *   npm run scrape:probate-estates
 *   npm run scrape:probate-estates -- --from 01/01/2026 --to 03/31/2026
 *   node scripts/scrape-probate-estates.mjs --headless   # OCR only, usually fails
 *   node scripts/scrape-probate-estates.mjs --no-details # skip decedent address fetch
 */

import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { stdin as input, stderr as output } from "process";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { captchaVariants, ocrProbateCaptcha } from "./probate-captcha.mjs";
import { openSearchForm, BASE_URL } from "./probate-session.mjs";
import {
  incrementalFromUsDate,
  markSourceRun,
  parseUsDate,
  fmtUsDate,
  dayOutputExists,
  loadDayRecords,
  writeDayOutputs,
  writeCanonicalFromDays,
} from "./scrape-state.mjs";
import { enrichProbateRecords } from "./enrich-probate-addresses.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ID = "probate-estates";
const DATA_DIR = path.join(__dirname, "..", "data");
const CAPTCHA_IMAGE = path.join(DATA_DIR, "probate-captcha.png");
const LAST_RESULTS_HTML = path.join(DATA_DIR, "_probate-last-results.html");
const DAY_RULE = "────────────────────────────────────────";

function logDayHeader(label) {
  console.error("");
  console.error(DAY_RULE);
  console.error(`  ${label}`);
  console.error(DAY_RULE);
}

function logDayFooter() {
  console.error("");
}

function parseArgs() {
  const captchaArg = process.argv.find((a) => a.startsWith("--captcha="))?.split("=")[1];
  const fromIdx = process.argv.indexOf("--from");
  const toIdx = process.argv.indexOf("--to");

  const headless = process.argv.includes("--headless");
  const base = {
    interactive: !headless || process.argv.includes("--interactive"),
    headed: !headless || process.argv.includes("--headed") || process.argv.includes("--interactive"),
    byMonth: process.argv.includes("--by-month"),
    force: process.argv.includes("--force"),
    details: !process.argv.includes("--no-details"),
    captchaArg,
  };

  if (fromIdx >= 0 && toIdx >= 0) {
    return { ...base, mode: "range", from: process.argv[fromIdx + 1], to: process.argv[toIdx + 1] };
  }

  return { ...base, mode: "incremental" };
}

function buildSearchPeriods(options) {
  const today = new Date();
  const from =
    options.mode === "range"
      ? parseUsDate(options.from)
      : parseUsDate(incrementalFromUsDate(SOURCE_ID));
  const to = options.mode === "range" ? parseUsDate(options.to) : today;

  if (!from || !to) throw new Error("Invalid date range");

  if (options.byMonth) {
    const periods = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    const end = new Date(to.getFullYear(), to.getMonth(), 1);
    while (cursor <= end) {
      periods.push({
        kind: "month",
        month: cursor.getMonth() + 1,
        day: null,
        year: cursor.getFullYear(),
        label: `${cursor.getMonth() + 1}/1/${cursor.getFullYear()}–${cursor.getMonth() + 1}/${new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()}/${cursor.getFullYear()}`,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return periods;
  }

  const periods = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    periods.push({
      kind: "day",
      month: d.getMonth() + 1,
      day: d.getDate(),
      year: d.getFullYear(),
      label: fmtUsDate(d),
    });
  }
  return periods;
}

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRecord(raw) {
  return {
    source: "richland_probate",
    case_number: raw.case_number ?? null,
    decedent_name: raw.decedent_name ?? null,
    file_date: raw.file_date ?? null,
    case_type: raw.case_type ?? "Estate",
    status: raw.status ?? null,
    detail_url: raw.detail_url ?? null,
    street_address: raw.street_address ?? null,
    city: raw.city ?? null,
    state: raw.state ?? null,
    zip: raw.zip ?? null,
    attorney: raw.attorney ?? null,
    filing_type: raw.filing_type ?? null,
  };
}

function caseNumberFromHref(href) {
  if (!href) return null;
  const m = href.match(/(?:case|number|cn)[=\/]([^&"' ]+)/i);
  return m ? clean(decodeURIComponent(m[1])) : null;
}

function parseRowRecord($, row, headers = []) {
  const cells = $(row)
    .find("td")
    .map((__, td) => clean($(td).text()))
    .get();
  if (cells.length < 1) return null;

  const link = $(row).find("a[href*='recordDetail'], a[href*='caseDetail'], a[onclick*='recordDetail'], a[onclick*='caseDetail']").first();
  const href = link.attr("href") || link.attr("onclick") || null;
  const caseNumber =
    clean(link.text()) ||
    caseNumberFromHref(href) ||
    cells.find((c) => /\d{4,}/.test(c)) ||
    cells[0];
  if (!caseNumber || !/\d/.test(caseNumber)) return null;

  const rowObj = {};
  headers.forEach((h, i) => {
    if (cells[i]) rowObj[h] = cells[i];
  });

  let detailUrl = null;
  if (href && !href.startsWith("javascript")) {
    try {
      detailUrl = new URL(href, BASE_URL).href;
    } catch {
      detailUrl = null;
    }
  }

  return normalizeRecord({
    case_number: caseNumber,
    decedent_name:
      rowObj.name ??
      rowObj["decedent name"] ??
      rowObj.party ??
      rowObj.decedent ??
      cells.find((c) => /,/.test(c) && !/\d{1,2}\/\d{1,2}\/\d/.test(c)) ??
      cells[1] ??
      null,
    file_date:
      rowObj["file date"] ??
      rowObj["filing date"] ??
      cells.find((c) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(c)) ??
      cells[2] ??
      null,
    case_type: rowObj.type ?? cells.find((c) => /estate/i.test(c)) ?? "Estate",
    status: rowObj.status ?? cells[cells.length - 1] ?? null,
    detail_url: detailUrl,
  });
}

function parseResults(html) {
  const $ = cheerio.load(html);
  const records = [];

  $("#searchResults .record").each((_, rec) => {
    const caseNumber = clean($(rec).find(".fullCaseNumber").first().text());
    if (!caseNumber || !/\d/.test(caseNumber)) return;

    const decedentName =
      clean($(rec).find(".caseField.concerningName").first().text()).replace(/^Concerning:\s*/i, "") ||
      clean($(rec).find(".caseTitle .concerningName").first().text()) ||
      null;
    const fileDate = clean($(rec).find(".caseField.fileDate").first().text()).replace(/^Filed:\s*/i, "");
    const caseType =
      clean($(rec).find(".caseField.caseType").first().text()).replace(/^Case Type:\s*/i, "") || "Estate";
    const status =
      clean($(rec).find(".caseField.violation").first().text()).replace(/^Viol\.\/Cause:\s*/i, "") || null;
    const href = $(rec).find("a.caseLink").first().attr("href");

    records.push(
      normalizeRecord({
        case_number: caseNumber,
        decedent_name: decedentName || null,
        file_date: fileDate || null,
        case_type: caseType,
        status,
        detail_url: href ? new URL(href, BASE_URL).href : null,
      })
    );
  });

  if (records.length > 0) {
    const seen = new Set();
    return records.filter((r) => {
      if (!r.case_number || seen.has(r.case_number)) return false;
      seen.add(r.case_number);
      return true;
    });
  }

  $("table").each((_, table) => {
    const headers = [];
    $(table)
      .find("tr")
      .first()
      .find("th, td")
      .each((__, cell) => headers.push(clean($(cell).text()).toLowerCase()));

    $(table)
      .find("tr")
      .each((__, row) => {
        if ($(row).find("a[href*='recordDetail'], a[href*='caseDetail'], a[onclick*='recordDetail'], a[onclick*='caseDetail']").length === 0) return;
        const rec = parseRowRecord($, row, headers);
        if (rec) records.push(rec);
      });
  });

  if (records.length === 0) {
    $("a[href*='recordDetail'], a[href*='caseDetail'], a[onclick*='recordDetail'], a[onclick*='caseDetail']").each((_, link) => {
      const row = $(link).closest("tr");
      const rec = parseRowRecord($, row.length ? row : $(link).parent(), []);
      if (rec) records.push(rec);
    });
  }

  const seen = new Set();
  return records.filter((r) => {
    if (!r.case_number || seen.has(r.case_number)) return false;
    seen.add(r.case_number);
    return true;
  });
}

function saveResultsDebug(html, period, records) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LAST_RESULTS_HTML, html);
  const countMatch =
    cheerio.load(html)("body").text().match(/\b(\d+)\s+cases?\s+(?:were\s+)?found/i) ||
    cheerio.load(html)("body").text().match(/\b(\d+)\s+matches?\s+(?:was|were)\s+found/i);
  const expected = countMatch ? Number(countMatch[1]) : null;
  if (expected != null && records.length !== expected) {
    console.error(
      `  WARNING: page shows ${expected} case(s) but parser got ${records.length} — see ${LAST_RESULTS_HTML}`
    );
  }
}

function countFromResultsText(text) {
  const m =
    text.match(/\b(\d+)\s+cases?\s+(?:were\s+)?found/i) ||
    text.match(/\b(\d+)\s+matches?\s+(?:was|were)\s+found/i);
  return m ? Number(m[1]) : null;
}

function matchCountSaysEmpty(text) {
  if (!text) return false;
  return (
    /\b0\s+matches?\s+(?:was|were)\s+found/i.test(text) ||
    /\bno\s+matches?\s+(?:was|were)\s+found/i.test(text)
  );
}

function matchCountSaysResults(text) {
  if (!text) return false;
  return /\b[1-9]\d*\s+matches?\s+(?:was|were)\s+found/i.test(text);
}

function isEmptyResultsPage(body, html) {
  if (/class="noMatchMessage"/i.test(html)) return true;
  if (/no cases found that match|no cases were found|0 cases were found|no matching cases|no matches were found/i.test(body)) {
    return true;
  }

  const matchCount = body.match(/matchCount[^>]*>([^<]+)/i)?.[1] || "";
  if (matchCountSaysEmpty(matchCount)) return true;

  const count = countFromResultsText(body);
  if (count === 0 && /\bmatches?\s+(?:was|were)\s+found/i.test(body)) return true;

  if (
    /you searched by file date/i.test(body) &&
    /search completed in/i.test(body) &&
    !/class="record"/i.test(html) &&
    (count === 0 || count == null)
  ) {
    return true;
  }

  if (/id="searchResults"/i.test(html) && /search completed in/i.test(body) && !/class="record"/i.test(html)) {
    return true;
  }

  return false;
}

function detectSearchOutcome({ recordCount = 0, matchCount = "", noMatchMessage = false, searchTime = "", searchedHeader = false }) {
  if (recordCount > 0) return "results";
  if (matchCountSaysResults(matchCount)) return "results";
  if (noMatchMessage || matchCountSaysEmpty(matchCount)) return "empty";
  if (searchedHeader && /search completed in/i.test(searchTime) && recordCount === 0) return "empty";
  return null;
}

function isResultsPage(body, html) {
  if (/#searchResults|id="searchResults"/i.test(html) && /class="record"/i.test(html)) return true;
  if (/recordDetail|recordResults|caseDetail/i.test(html)) return true;
  if (countFromResultsText(body) != null && countFromResultsText(body) > 0) return true;
  if (/^Search Results/im.test(body) && !/View your search results/i.test(body)) return true;
  return false;
}

function submitMessage(body) {
  const m = body.match(/messageContainer[\s\S]*?(?=Copyright|$)/i);
  return m ? m[0] : body;
}

function pageState(body, html) {
  const msg = submitMessage(body);
  if (/CAPTCHA response was incorrect/i.test(msg)) return "captcha_bad";
  if (/You need to provide the entire file date/i.test(msg)) return "validation_error";
  if (isEmptyResultsPage(body, html)) return "empty";
  if (isResultsPage(body, html)) return "results";
  return "waiting";
}

async function fillEstateSearch(page, period) {
  await openSearchForm(page, page.context());
  await page.waitForSelector("#checkCaseType-PE", { state: "visible", timeout: 30000 });

  for (const id of ["checkCaseType-PC", "checkCaseType-PG", "checkCaseType-PR", "checkCaseType-PM", "checkCaseType-PT"]) {
    await page.locator(`#${id}`).uncheck({ force: true });
  }
  await page.locator("#checkCaseType-PE").check({ force: true });

  await page.selectOption("#searchFMonth", String(period.month));
  if (period.day) await page.selectOption("#searchFDay", String(period.day));
  await page.selectOption("#searchFYear", String(period.year));
  await page.locator("#optionBlock-100").check({ force: true });

  const pe = await page.locator("#checkCaseType-PE").isChecked();
  const perPage = await page.locator("#optionBlock-100").isChecked();
  console.error(`  Form filled: Estate=${pe}, 100/page=${perPage}, date=${period.label}`);
  await page.locator("#captchaResponse").scrollIntoViewIfNeeded().catch(() => null);
}

async function promptCaptcha(page) {
  fs.mkdirSync(path.dirname(CAPTCHA_IMAGE), { recursive: true });
  await page.locator("#captchaImage").screenshot({ path: CAPTCHA_IMAGE });
  const rl = readline.createInterface({ input, output });
  const code = clean(await rl.question(`Enter CAPTCHA from ${CAPTCHA_IMAGE}: `));
  await rl.close();
  return code;
}

async function waitForEnter(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(message);
  await rl.close();
}

async function readSearchSnapshot(page) {
  return page
    .evaluate(() => {
      const matchCount = document.getElementById("matchCount")?.innerText?.trim() || "";
      const recordCount = document.querySelectorAll("#searchResults .record").length;
      const noMatchMessage = !!document.querySelector(".noMatchMessage");
      const searchTime = document.getElementById("searchTime")?.innerText?.trim() || "";
      const searchedHeader = !!document.querySelector("#searchHeader h3.search");
      return { matchCount, recordCount, noMatchMessage, searchTime, searchedHeader };
    })
    .catch(() => ({
      matchCount: "",
      recordCount: 0,
      noMatchMessage: false,
      searchTime: "",
      searchedHeader: false,
    }));
}

async function waitForBrowserCaptcha(page, period) {
  console.error('>>> Enter CAPTCHA in the automation browser and click "Begin Search".');
  console.error("    (Waiting up to 10 minutes per search…)\n");

  const deadline = Date.now() + 600000;

  while (Date.now() < deadline) {
    const snapshot = await readSearchSnapshot(page);
    const outcome = detectSearchOutcome(snapshot);

    if (outcome === "results") {
      const detail =
        snapshot.recordCount > 0
          ? `${snapshot.recordCount} record(s) on page`
          : snapshot.matchCount || "results detected";
      console.error(`  Search finished — ${detail} — saving…`);
      return "results";
    }
    if (outcome === "empty") {
      console.error("  Search finished — 0 case(s) — saving…");
      return "empty";
    }

    const body = await page.innerText("body").catch(() => "");
    const html = await page.content().catch(() => "");
    const state = pageState(body, html);
    if (state === "results") {
      console.error("  Search finished — saving…");
      return "results";
    }
    if (state === "empty") {
      console.error("  Search finished — 0 case(s) — saving…");
      return "empty";
    }
    if (state === "captcha_bad") {
      console.error("  CAPTCHA incorrect — try again in the browser.");
      await page.waitForTimeout(500);
      continue;
    }
    if (state === "validation_error") {
      console.error("  Date validation error — retrying form.");
      await fillEstateSearch(page, period);
      continue;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for search results for ${period.label}`);
}

async function submitCaptchaSearch(page, code) {
  await page.locator("#captchaResponse").fill(code);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
    page.locator("#buttonSubmit").click(),
  ]);
  await page.waitForTimeout(1200);
}

async function resolveCaptchaCodes(page, options) {
  if (options.captchaArg) return [options.captchaArg];

  const buf = await page.locator("#captchaImage").screenshot();
  const ocr = await ocrProbateCaptcha(buf);
  const variants = captchaVariants(ocr);
  if (variants.length) return variants.slice(0, 12);

  if (options.interactive) return [await promptCaptcha(page)];

  return [];
}

async function searchEstatePeriod(page, period, options) {
  if (options.interactive) {
    await fillEstateSearch(page, period);
    const state = await waitForBrowserCaptcha(page, period);
    await page.waitForLoadState("networkidle").catch(() => null);
    const html = await page.content();
    if (state === "empty") {
      saveResultsDebug(html, period, []);
      return [];
    }
    const records = parseResults(html);
    saveResultsDebug(html, period, records);
    return records;
  }

  if (options.captchaArg) {
    await fillEstateSearch(page, period);
    console.error(`  ${period.label} captcha: using "${options.captchaArg}"`);
    await submitCaptchaSearch(page, options.captchaArg);
    const body = await page.innerText("body");
    const html = await page.content();
    const state = pageState(body, html);
    if (state === "captcha_bad") {
      throw new Error(`CAPTCHA rejected for ${period.label} — code must match the image in the same browser session`);
    }
    if (state === "empty") return [];
    if (state === "results") return parseResults(html);
    throw new Error(`Unexpected response for ${period.label}`);
  }

  for (let round = 1; round <= 8; round++) {
    await fillEstateSearch(page, period);
    const codes = await resolveCaptchaCodes(page, options);
    if (codes.length === 0) {
      throw new Error(
        "CAPTCHA OCR failed. Re-run with --interactive (headed browser) or --captcha=CODE"
      );
    }

    for (const code of codes) {
      if (round > 1 || code !== codes[0]) {
        await page.evaluate(() => captchaRefresh());
        await page.waitForTimeout(600);
      }
      console.error(`  ${period.label} captcha: trying "${code}"`);
      await submitCaptchaSearch(page, code);

      const body = await page.innerText("body");
      const html = await page.content();
      const state = pageState(body, html);
      if (state === "captcha_bad") continue;
      if (state === "validation_error") {
        throw new Error(`${period.label}: CaseLook requires month, day, and year (month-only search is not supported)`);
      }
      if (state === "empty") return [];
      if (state === "results") return parseResults(html);
    }

    options.captchaArg = undefined;
  }

  throw new Error(`Search failed for ${period.label} after CAPTCHA retries`);
}

async function scrapeProbateEstates(periods, options) {
  const browser = await chromium.launch({
    headless: !options.headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const allRecords = [];
  const runRecords = [];
  try {
    for (const period of periods) {
      logDayHeader(period.label);

      if (!options.force && dayOutputExists("probate-estates", period.label)) {
        const saved = loadDayRecords("probate-estates", period.label);
        allRecords.push(...saved);
        console.error(`Skipping — already saved (${saved.length} case(s))`);
        logDayFooter();
        continue;
      }

      console.error(`Searching estate filings filed ${period.label}...`);
      let records = await searchEstatePeriod(page, period, options);
      console.error(`  ${records.length} case(s)`);

      if (options.details && records.length) {
        console.error(`  Fetching decedent addresses from detail pages...`);
        const { records: enriched, stats } = await enrichProbateRecords(page, records, { delayMs: 400 });
        records = enriched;
        console.error(`  Addresses found: ${stats.withAddress}/${records.length}`);
      } else if (!options.details && records.length) {
        console.error("  Skipping detail pages (--no-details)");
      }

      const { json, csv } = writeDayOutputs("probate-estates", period.label, records);
      console.error(`  Wrote ${json}`);

      markSourceRun(SOURCE_ID, {
        last_from_date: periods[0].label,
        last_to_date: period.label,
      });

      const { canonical, canonicalJson } = writeCanonicalFromDays("probate-estates", (r) => r.case_number);
      console.error(`  Canonical total: ${canonical.length} (${canonicalJson})`);

      allRecords.push(...records);
      runRecords.push(...records);
      logDayFooter();
    }
    return { allRecords, runRecords };
  } finally {
    if (options.interactive) {
      await waitForEnter("\nPress Enter to close the browser...");
    }
    await browser.close();
  }
}

async function main() {
  const options = parseArgs();
  const periods = buildSearchPeriods(options);

  if (periods.length === 0) {
    console.error("No periods to search.");
    return;
  }

  console.error(
    `Probate estate search: ${periods.length} ${options.byMonth ? "month(s)" : "day(s)"} from ${periods[0].label} to ${periods[periods.length - 1].label}`
  );
  if (options.interactive) {
    console.error("Attended mode: solve each CAPTCHA in the browser and click Begin Search.");
  }

  const delta = await scrapeProbateEstates(periods, options);
  const { canonical, canonicalJson, canonicalCsv } = writeCanonicalFromDays(
    "probate-estates",
    (r) => r.case_number
  );

  console.error(`Fetched this run:  ${delta.runRecords.length}`);
  console.error(`Canonical total:   ${canonical.length}`);
  console.error(`Day files:         data/probate-estates-day-YYYY-MM-DD.json`);
  console.error(`Wrote ${canonicalJson}`);
  console.error(`Wrote ${canonicalCsv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Scrape Mansfield Building & Codes compliance records (Accela Citizen Access).
 *
 * Richland County residential/commercial code compliance cases filed with
 * Mansfield Municipal Building Department. Public search — no login or CAPTCHA.
 *
 * Usage:
 *   npm run scrape:code-violations
 *   npm run scrape:code-violations -- --from 01/01/2026 --to 06/05/2026
 *   node scripts/scrape-code-violations.mjs --residential-only
 */

import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import {
  incrementalFromUsDate,
  markSourceRun,
  parseUsDate,
  fmtUsDate,
  monthOutputExists,
  loadMonthRecords,
  writeMonthOutputs,
  writeCanonicalFromMonths,
} from "./scrape-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ID = "code-violations";
const BASE = "https://aca-prod.accela.com/MANSFIELD";
const SEARCH_URL = `${BASE}/Cap/CapHome.aspx?module=Building&TabName=Building`;
const ORIGIN = "https://aca-prod.accela.com";
const MONTH_RULE = "────────────────────────────────────────";

const RECORD_TYPES = [
  {
    value: "Building/Residential/Occupancy/Code Compliance",
    label: "Residential Code Compliance",
  },
  {
    value: "Building/Commercial/Occupancy/Code Compliance",
    label: "Commercial Code Compliance",
  },
];

function parseArgs() {
  const fromIdx = process.argv.indexOf("--from");
  const toIdx = process.argv.indexOf("--to");
  const base = {
    force: process.argv.includes("--force"),
    residentialOnly: process.argv.includes("--residential-only"),
    commercialOnly: process.argv.includes("--commercial-only"),
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
    periods.push({
      year: cursor.getFullYear(),
      month: cursor.getMonth() + 1,
      label: `${cursor.getMonth() + 1}/${cursor.getFullYear()}`,
      from: fmtUsDate(monthStart < from ? from : monthStart),
      to: fmtUsDate(monthEnd > to ? to : monthEnd),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return periods;
}

function recordTypesForRun(options) {
  if (options.residentialOnly) return RECORD_TYPES.slice(0, 1);
  if (options.commercialOnly) return RECORD_TYPES.slice(1);
  return RECORD_TYPES;
}

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtUsDatePadded(d) {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

function periodToAccelaDates(period) {
  const from = parseUsDate(period.from);
  const to = parseUsDate(period.to);
  return {
    from: from ? fmtUsDatePadded(from) : period.from,
    to: to ? fmtUsDatePadded(to) : period.to,
  };
}

function logMonthHeader(label) {
  console.error("");
  console.error(MONTH_RULE);
  console.error(`  ${label}`);
  console.error(MONTH_RULE);
}

function logMonthFooter() {
  console.error("");
}

function parseAddress(raw) {
  const text = clean(raw);
  if (!text) return { property_address: null, city: null, state: null, zip: null };

  const m = text.match(/^(.+?),\s*([A-Za-z .]+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m) {
    return {
      property_address: clean(m[1]),
      city: clean(m[2]),
      state: m[3].toUpperCase(),
      zip: m[4],
    };
  }

  return { property_address: text, city: null, state: null, zip: null };
}

function parseShowingRange(html) {
  const m = html.match(/Showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  if (!m) return null;
  return { start: parseInt(m[1], 10), end: parseInt(m[2], 10), total: parseInt(m[3], 10) };
}

function parseResultsGrid(html) {
  const $ = cheerio.load(html);
  const records = [];

  $("#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList tr").each((_, tr) => {
    const row = $(tr);
    const cls = row.attr("class") || "";
    if (!/ACA_TabRow_Odd|ACA_TabRow_Even/.test(cls)) return;

    const recordNumber =
      clean(row.find("[id*='lblPermitNumber1']").first().text()) ||
      clean(row.find("[id*='lblPermitNumber']").first().text());
    if (!recordNumber) return;

    const detailPath = row.find("a[href*='CapDetail.aspx']").attr("href") || null;
    const capIds = detailPath?.match(/capID1=([^&]+)&capID2=([^&]+)&capID3=([^&]+)/i);

    records.push({
      source: "mansfield_accela",
      court: "Mansfield Building & Codes",
      record_number: recordNumber,
      record_id: row.find("input[type='hidden'][ID='RecordId']").attr("value") || null,
      cap_id: capIds ? `${capIds[1]}-${capIds[2]}-${capIds[3]}` : null,
      record_type: clean(row.find("[id*='lblType']").first().text()) || null,
      updated_date: clean(row.find("[id*='lblUpdatedTime']").first().text()) || null,
      expiration_date: clean(row.find("[id*='lblExpirationDate']").first().text()) || null,
      status: clean(row.find("[id*='lblStatus']").first().text()) || null,
      description: clean(row.find("[id*='lblDescription']").first().text()) || null,
      project_name: clean(row.find("[id*='lblProjectName']").first().text()) || null,
      ...parseAddress(row.find("[id*='lblPermitAddress']").first().text()),
      detail_url: detailPath ? new URL(detailPath, ORIGIN).href : null,
    });
  });

  return records;
}

function inPeriod(dateStr, period) {
  const d = parseUsDate(dateStr);
  const from = parseUsDate(period.from);
  const to = parseUsDate(period.to);
  if (!d || !from || !to) return true;
  return d >= from && d <= to;
}

function dedupeRecords(records) {
  const map = new Map();
  for (const rec of records) {
    const key = rec.record_number || rec.cap_id || rec.record_id;
    if (!key) continue;
    if (!map.has(key)) map.set(key, rec);
  }
  return [...map.values()];
}

async function setDateField(page, id, value) {
  await page.evaluate(
    ({ id, value }) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Missing #${id}`);
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { id, value }
  );
}

async function submitCodeSearch(page, period, recordType) {
  const dates = periodToAccelaDates(period);

  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("#ctl00_PlaceHolderMain_generalSearchForm_ddlGSPermitType", { timeout: 60000 });

  await page.selectOption("#ctl00_PlaceHolderMain_generalSearchForm_ddlGSPermitType", recordType.value);
  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => null);
  await page.waitForTimeout(800);

  await setDateField(page, "ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate", dates.from);
  await setDateField(page, "ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate", dates.to);

  const actual = await page.evaluate(() => ({
    from: document.getElementById("ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate")?.value || "",
    to: document.getElementById("ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate")?.value || "",
  }));
  if (actual.from !== dates.from || actual.to !== dates.to) {
    throw new Error(`Date fields not set (got ${actual.from} – ${actual.to}, want ${dates.from} – ${dates.to})`);
  }

  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("CapHome.aspx") && r.request().method() === "POST",
      { timeout: 120000 }
    ).catch(() => null),
    page.locator("#ctl00_PlaceHolderMain_btnNewSearch").click(),
  ]);

  await page.waitForTimeout(1500);
  await page
    .waitForSelector("#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList, .ACA_NoRecordFound", {
      timeout: 120000,
    })
    .catch(() => null);
}

async function collectResultPages(page) {
  const all = [];

  for (;;) {
    const html = await page.content();
    all.push(...parseResultsGrid(html));

    const range = parseShowingRange(html);
    if (!range || range.end >= range.total) break;

    const nextLink = page.locator(
      "#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList a[id*='Pager'][title='Next Page'], " +
        "#ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList a:has-text('Next')"
    ).first();

    if (!(await nextLink.isVisible().catch(() => false))) break;

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("CapHome.aspx") && r.request().method() === "POST",
        { timeout: 120000 }
      ).catch(() => null),
      nextLink.click(),
    ]);
    await page.waitForTimeout(1500);
  }

  return all;
}

async function scrapeCodeViolations(periods, options) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage();
  const runRecords = [];
  const allRecords = [];
  const types = recordTypesForRun(options);

  try {
    for (const period of periods) {
      logMonthHeader(`${period.label} (${period.from} – ${period.to})`);

      if (!options.force && monthOutputExists(SOURCE_ID, period.year, period.month)) {
        const saved = loadMonthRecords(SOURCE_ID, period.year, period.month);
        allRecords.push(...saved);
        console.error(`Skipping — already saved (${saved.length} record(s))`);
        logMonthFooter();
        continue;
      }

      const monthRecords = [];

      for (const recordType of types) {
        console.error(`Searching ${recordType.label} filed ${period.from} – ${period.to}...`);
        await submitCodeSearch(page, period, recordType);
        const rows = await collectResultPages(page);
        const inRange = rows.filter((r) => inPeriod(r.updated_date, period));
        console.error(`  ${rows.length} row(s) → ${inRange.length} in range`);
        monthRecords.push(...inRange);
      }

      const records = dedupeRecords(monthRecords);
      console.error(`  Saved ${records.length} unique record(s)`);

      const { json } = writeMonthOutputs(SOURCE_ID, period.year, period.month, records);
      console.error(`  Wrote ${json}`);

      markSourceRun(SOURCE_ID, {
        last_from_date: period.from,
        last_to_date: period.to,
      });

      const { canonical, canonicalJson } = writeCanonicalFromMonths(SOURCE_ID, (r) => r.record_number);
      console.error(`  Canonical total: ${canonical.length} (${canonicalJson})`);

      allRecords.push(...records);
      runRecords.push(...records);
      logMonthFooter();
    }

    return { allRecords, runRecords };
  } finally {
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
    `Code compliance search: ${periods.length} month(s) from ${periods[0].label} to ${periods[periods.length - 1].label}`
  );

  const delta = await scrapeCodeViolations(periods, options);
  const { canonical, canonicalJson, canonicalCsv } = writeCanonicalFromMonths(SOURCE_ID, (r) => r.record_number);

  console.error(`Fetched this run:  ${delta.runRecords.length}`);
  console.error(`Canonical total:   ${canonical.length}`);
  console.error(`Month files:       data/code-violations-month-YYYY-MM.json`);
  console.error(`Wrote ${canonicalJson}`);
  console.error(`Wrote ${canonicalCsv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

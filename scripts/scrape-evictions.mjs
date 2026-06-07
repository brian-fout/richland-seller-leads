/**
 * Scrape Mansfield Municipal Court eviction filings (BenchmarkWeb).
 *
 * Richland County FED/eviction cases are filed with Mansfield Municipal Court.
 * Public search — no login or CAPTCHA required.
 *
 * Usage:
 *   npm run scrape:evictions
 *   npm run scrape:evictions -- --from 01/01/2026 --to 06/05/2026
 *   node scripts/scrape-evictions.mjs --no-details   # skip case detail pages
 */

import fs from "fs";
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
const DATA_DIR = path.join(__dirname, "..", "data");
const SOURCE_ID = "evictions";
const BASE = "https://benchmark.mansfieldcity.com/BenchmarkWeb";
const SEARCH_URL = `${BASE}/Home.aspx/Search`;
const ORIGIN = "https://benchmark.mansfieldcity.com";
const PAGE_SIZE = 100;
const MONTH_RULE = "────────────────────────────────────────";

function parseArgs() {
  const fromIdx = process.argv.indexOf("--from");
  const toIdx = process.argv.indexOf("--to");
  const base = {
    force: process.argv.includes("--force"),
    details: !process.argv.includes("--no-details"),
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

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function buildDataTablesBody({ start, length, draw }) {
  const params = new URLSearchParams();
  params.set("draw", String(draw));
  for (let i = 0; i < 5; i++) {
    params.set(`columns[${i}][data]`, String(i));
    params.set(`columns[${i}][name]`, "");
    params.set(`columns[${i}][searchable]`, "true");
    params.set(`columns[${i}][orderable]`, i === 0 ? "false" : "true");
    params.set(`columns[${i}][search][value]`, "");
    params.set(`columns[${i}][search][regex]`, "false");
  }
  params.set("order[0][column]", "3");
  params.set("order[0][dir]", "desc");
  params.set("start", String(start));
  params.set("length", String(length));
  params.set("search[value]", "");
  params.set("search[regex]", "false");
  return params.toString();
}

function stripCell(html) {
  const $ = cheerio.load(`<div>${html}</div>`);
  return clean($.root().text());
}

function parseSearchRow(cells) {
  const htmlName = cells["1"] || "";
  const htmlCase = cells["3"] || "";
  const htmlSummary = cells["0"] || "";
  const partyType = stripCell(cells["2"]);
  const status = stripCell(cells["4"]);
  const caseNumber = stripCell(htmlCase) || cheerio.load(htmlCase)("a").first().text().trim();
  const partyName = stripCell(htmlName) || cheerio.load(htmlName)("a").first().text().trim();

  const caseHref =
    cheerio.load(htmlCase)("a[href*='CourtCase.aspx/Details']").attr("href") ||
    cheerio.load(htmlSummary)("a[href*='CourtCase.aspx/Details']").attr("href");
  const caseIdMatch =
    caseHref?.match(/Details\/(\d+)/) ||
    htmlSummary.match(/details\((\d+)/i) ||
    htmlSummary.match(/imgExpand_(\d+)/i);

  return {
    party_name: partyName || null,
    party_type: partyType || null,
    case_number: caseNumber || null,
    status: status || null,
    case_id: caseIdMatch ? caseIdMatch[1] : null,
    detail_path: caseHref || null,
  };
}

function parseAddressBlock(html) {
  const $ = cheerio.load(`<td>${html}</td>`);
  const lines = $.root()
    .text()
    .split("\n")
    .map((l) => clean(l))
    .filter(Boolean);
  const street = lines[0] || null;
  const csz = lines[1] || "";
  const m = csz.match(/^(.+?),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/i);
  return {
    street,
    city: m ? clean(m[1]) : csz || null,
    state: m?.[2]?.toUpperCase() ?? null,
    zip: m?.[3] ?? null,
  };
}

function uniqueJoin(values) {
  return [...new Set(values.map((v) => clean(v)).filter(Boolean))].join("; ");
}

function inPeriod(fileDate, period) {
  const d = parseUsDate(fileDate);
  const from = parseUsDate(period.from);
  const to = parseUsDate(period.to);
  if (!d || !from || !to) return true;
  return d >= from && d <= to;
}

function parseCaseDetail(html, detailUrl) {
  const $ = cheerio.load(html);
  const fileDate = clean($("dt.clerkfiledate").next("dd").text()) || null;
  const status = clean($("dt.status").first().next("dd").text()) || null;
  const caseType = clean($("dt.casetype").first().next("dd").text()) || "Eviction";

  let hearingDate = null;
  $("table tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((__, td) => clean($(td).text()))
      .get();
    if (cells[1] && /eviction hearing/i.test(cells[1])) hearingDate = cells[0] || hearingDate;
  });

  const parties = [];
  const seenParty = new Set();
  for (const table of $("table").toArray()) {
    const headers = $(table)
      .find("th")
      .map((__, th) => clean($(th).text()).toLowerCase())
      .get();
    if (!headers.includes("party name") || !headers.includes("address")) continue;

    $(table)
      .find("tbody tr")
      .each((__, tr) => {
        const tds = $(tr).find("td");
        if (tds.length < 3) return;
        const type = clean($(tds[0]).text());
        if (!/PLAINTIFF|DEFENDANT/i.test(type)) return;
        const name = clean($(tds[1]).find("a").first().text() || $(tds[1]).text());
        if (!name) return;
        const key = `${type}:${name}`;
        if (seenParty.has(key)) return;
        seenParty.add(key);
        parties.push({
          type: type.replace(/\s+$/, ""),
          name,
          ...parseAddressBlock($(tds[2]).html() || ""),
        });
      });
    break;
  }

  const plaintiffs = parties.filter((p) => p.type === "PLAINTIFF");
  const defendants = parties.filter((p) => p.type === "DEFENDANT");
  const primaryDef = defendants[0];

  return {
    source: "mansfield_municipal",
    court: "Mansfield Municipal Court",
    case_type: caseType,
    file_date: fileDate,
    status: clean(status?.split(/\s+/)[0]) || null,
    hearing_date: hearingDate,
    plaintiff_name: uniqueJoin(plaintiffs.map((p) => p.name)) || null,
    plaintiff_address: plaintiffs[0]
      ? [plaintiffs[0].street, plaintiffs[0].city, plaintiffs[0].state, plaintiffs[0].zip].filter(Boolean).join(", ")
      : null,
    defendant_names: uniqueJoin(defendants.map((p) => p.name)) || null,
    property_address: primaryDef?.street ?? null,
    city: primaryDef?.city ?? null,
    state: primaryDef?.state ?? null,
    zip: primaryDef?.zip ?? null,
    detail_url: detailUrl,
  };
}

async function setMultiselect(page, selectId, values) {
  await page.evaluate(
    ({ selectId, values }) => {
      const select = document.getElementById(selectId);
      if (!select) throw new Error(`Missing #${selectId}`);
      for (const opt of select.options) opt.selected = values.includes(opt.value);
      window.jQuery(`#${selectId}`).multiselect("refresh");
    },
    { selectId, values }
  );
}

async function submitEvictionSearch(page, period) {
  await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(800);
  await page.locator("#allCheck").check({ force: true });
  await setMultiselect(page, "courTypes", ["6"]);
  await setMultiselect(page, "caseTypes", ["6"]);

  await page.evaluate(
    ({ from, to }) => {
      const set = (id, value) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("openedFrom", from);
      set("openedTo", to);
    },
    { from: period.from, to: period.to }
  );

  const dates = await page.evaluate(() => ({
    from: document.getElementById("openedFrom")?.value || "",
    to: document.getElementById("openedTo")?.value || "",
  }));
  if (dates.from !== period.from || dates.to !== period.to) {
    throw new Error(`Date fields not set (got ${dates.from} – ${dates.to})`);
  }

  await Promise.all([
    page.waitForURL(/CaseSearch/, { timeout: 120000 }),
    page.locator("#searchButton").click(),
  ]);
  await page.waitForSelector("#gridSearchResults", { timeout: 120000 });
}

async function fetchSearchPage(page, { start, length, draw }) {
  return page.evaluate(
    async ({ start, length, draw, body }) => {
      const resp = await fetch("/BenchmarkWeb/Search.aspx/CaseSearch", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
      });
      if (!resp.ok) throw new Error(`CaseSearch HTTP ${resp.status}`);
      return resp.json();
    },
    { start, length, draw, body: buildDataTablesBody({ start, length, draw }) }
  );
}

async function fetchAllSearchRows(page) {
  const rows = [];
  let start = 0;
  let draw = 1;
  let total = Infinity;

  while (start < total) {
    const json = await fetchSearchPage(page, { start, length: PAGE_SIZE, draw });
    total = json.recordsTotal ?? 0;
    for (const cells of json.data || []) rows.push(parseSearchRow(cells));
    if ((json.data || []).length === 0) break;
    start += PAGE_SIZE;
    draw += 1;
  }
  return { rows, total };
}

function indexCasesFromRows(rows) {
  const cases = new Map();
  for (const row of rows) {
    if (!row.case_number) continue;
    if (!cases.has(row.case_number)) {
      cases.set(row.case_number, {
        case_number: row.case_number,
        case_id: row.case_id,
        status: row.status,
        detail_path: row.detail_path,
        parties: [],
      });
    }
    const rec = cases.get(row.case_number);
    if (row.case_id && !rec.case_id) rec.case_id = row.case_id;
    if (row.detail_path && !rec.detail_path) rec.detail_path = row.detail_path;
    if (row.status && !rec.status) rec.status = row.status;
    if (row.party_name) {
      rec.parties.push({ name: row.party_name, type: row.party_type });
    }
  }
  return cases;
}

async function enrichCaseDetails(page, cases, fetchDetails) {
  if (!fetchDetails) {
    return [...cases.values()].map((c) => {
      const plaintiffs = c.parties.filter((p) => p.type === "PLAINTIFF").map((p) => p.name);
      const defendants = c.parties.filter((p) => p.type === "DEFENDANT").map((p) => p.name);
      return {
        source: "mansfield_municipal",
        court: "Mansfield Municipal Court",
        case_number: c.case_number,
        case_id: c.case_id,
        case_type: "Eviction",
        status: c.status,
        plaintiff_name: plaintiffs.join("; ") || null,
        defendant_names: defendants.join("; ") || null,
        detail_url: c.detail_path ? new URL(c.detail_path, ORIGIN).href : null,
      };
    });
  }

  const records = [];
  const list = [...cases.values()];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c.detail_path) continue;
    const detailUrl = new URL(c.detail_path, ORIGIN).href;
    try {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("dt.clerkfiledate", { timeout: 15000 }).catch(() => null);
      const html = await page.content();
      if (/Access Denied|do not have permissions/i.test(html)) {
        console.error(`  Skipped ${c.case_number} — access denied on detail page`);
        continue;
      }
      const rec = parseCaseDetail(html, detailUrl);
      records.push({ ...rec, case_number: c.case_number, case_id: c.case_id });
    } catch (err) {
      console.error(`  Detail failed for ${c.case_number}: ${err.message}`);
    }
    if ((i + 1) % 25 === 0) console.error(`  Details ${i + 1}/${list.length}...`);
  }
  return records;
}

async function scrapeEvictions(periods, options) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage();
  const runRecords = [];
  const allRecords = [];

  try {
    for (const period of periods) {
      logMonthHeader(`${period.label} (${period.from} – ${period.to})`);

      if (!options.force && monthOutputExists("evictions", period.year, period.month)) {
        const saved = loadMonthRecords("evictions", period.year, period.month);
        allRecords.push(...saved);
        console.error(`Skipping — already saved (${saved.length} case(s))`);
        logMonthFooter();
        continue;
      }

      console.error(`Searching evictions filed ${period.from} – ${period.to}...`);
      await submitEvictionSearch(page, period);
      const { rows, total } = await fetchAllSearchRows(page);
      const cases = indexCasesFromRows(rows);
      console.error(`  ${total} party row(s) → ${cases.size} unique case(s)`);

      const records = (await enrichCaseDetails(page, cases, options.details)).filter((rec) =>
        inPeriod(rec.file_date, period)
      );
      console.error(`  Saved ${records.length} case record(s) in range`);

      const { json } = writeMonthOutputs("evictions", period.year, period.month, records);
      console.error(`  Wrote ${json}`);

      markSourceRun(SOURCE_ID, {
        last_from_date: period.from,
        last_to_date: period.to,
      });

      const { canonical, canonicalJson } = writeCanonicalFromMonths("evictions", (r) => r.case_number);
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
    `Eviction search: ${periods.length} month(s) from ${periods[0].label} to ${periods[periods.length - 1].label}`
  );
  if (!options.details) {
    console.error("Skipping case detail pages (--no-details). Addresses will be missing.");
  }

  const delta = await scrapeEvictions(periods, options);
  const { canonical, canonicalJson, canonicalCsv } = writeCanonicalFromMonths("evictions", (r) => r.case_number);

  console.error(`Fetched this run:  ${delta.runRecords.length}`);
  console.error(`Canonical total:   ${canonical.length}`);
  console.error(`Month files:       data/evictions-month-YYYY-MM.json`);
  console.error(`Wrote ${canonicalJson}`);
  console.error(`Wrote ${canonicalCsv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

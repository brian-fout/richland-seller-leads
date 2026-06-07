/**
 * Scrape early pre-foreclosure leads from Richland County OH Recorder (CountyFusion).
 *
 * Searches for LIS PENDENS and LIS PENDENS NC filings — the start of the
 * foreclosure process — as opposed to late-stage sheriff sale auctions.
 *
 * Usage:
 *   node scripts/scrape-lis-pendens.mjs              # since last run (Jan 1 on first run)
 *   node scripts/scrape-lis-pendens.mjs --force      # ignore last run, from Jan 1 this year
 *   node scripts/scrape-lis-pendens.mjs --from 01/01/2024 --to 12/31/2024
 *   node scripts/scrape-lis-pendens.mjs --all        # full history (2000–today, by year)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  incrementalFromUsDate,
  markSourceRun,
  mergeByKey,
  loadCanonicalRecords,
  writeRunOutputs,
} from "./scrape-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data");
const BASE = "https://countyfusion13.kofiletech.us/countyweb";
const LOGIN_URL = `${BASE}/loginDisplay.action?countyname=RichlandOH`;

const DOC_TYPES = ["LIS PENDENS", "LIS PENDENS NC"];
const DEFAULT_START_YEAR = 2000;
const RECORDS_PER_PAGE = "500";

const SOURCE_ID = "lis-pendens";

function parseArgs() {
  if (process.argv.includes("--all")) {
    const startYearIdx = process.argv.indexOf("--start-year");
    const startYear =
      startYearIdx >= 0 ? parseInt(process.argv[startYearIdx + 1], 10) : DEFAULT_START_YEAR;
    return { mode: "all", startYear: Number.isFinite(startYear) ? startYear : DEFAULT_START_YEAR };
  }

  const fromIdx = process.argv.indexOf("--from");
  const toIdx = process.argv.indexOf("--to");
  if (fromIdx >= 0 && toIdx >= 0) {
    return { mode: "range", from: process.argv[fromIdx + 1], to: process.argv[toIdx + 1] };
  }

  const daysIdx = process.argv.indexOf("--days");
  if (daysIdx >= 0) {
    const days = parseInt(process.argv[daysIdx + 1], 10);
    return { mode: "days", daysBack: Number.isFinite(days) && days > 0 ? days : 90 };
  }

  if (process.argv.includes("--force")) {
    return { mode: "force" };
  }

  return { mode: "incremental" };
}

function buildDateRanges(options) {
  const today = new Date();

  if (options.mode === "incremental" || options.mode === "force") {
    const from =
      options.mode === "force"
        ? `01/01/${today.getFullYear()}`
        : incrementalFromUsDate(SOURCE_ID);
    return [{ label: options.mode, from, to: fmtDate(today) }];
  }

  if (options.mode === "days") {
    const start = new Date(today);
    start.setDate(start.getDate() - options.daysBack);
    return [{ label: `last-${options.daysBack}-days`, from: fmtDate(start), to: fmtDate(today) }];
  }

  if (options.mode === "range") {
    return [{ label: `${options.from}-${options.to}`, from: options.from, to: options.to }];
  }

  const endYear = today.getFullYear();
  const ranges = [];
  for (let year = options.startYear; year <= endYear; year++) {
    ranges.push({
      label: String(year),
      from: `01/01/${year}`,
      to: year === endYear ? fmtDate(today) : `12/31/${year}`,
    });
  }
  return ranges;
}

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

function splitNames(text) {
  return clean(text)
    .split(/\s*;\s*|\s*\n\s*/)
    .map((s) => clean(s))
    .filter(Boolean);
}

function parseLegalDescription(text) {
  const value = clean(text);
  const pipe = value.indexOf("|");
  const municipality = pipe >= 0 ? clean(value.slice(0, pipe)) : value || null;
  const remarksMatch = value.match(/Remarks:\s*(.+)$/i);
  return {
    municipality: municipality || null,
    legal_description: value || null,
    remarks: remarksMatch ? clean(remarksMatch[1]) : null,
  };
}

function normalizeRecord(raw) {
  const { municipality, legal_description, remarks } = parseLegalDescription(raw.legal_description);
  return {
    source: "richland_recorder",
    instrument_id: raw.instrument_id ?? null,
    instrument_number: raw.instrument_number ?? null,
    book: raw.book ?? null,
    page: raw.page ?? null,
    document_type: raw.document_type ?? null,
    recorded_date: raw.recorded_date ?? null,
    grantor_names: splitNames(raw.grantor_names).join("; "),
    defendant_names: splitNames(raw.defendant_names).join("; "),
    municipality,
    legal_description,
    remarks,
    reference: raw.reference ?? null,
  };
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter((r) => {
    const key = r.instrument_number ?? r.instrument_id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toCsv(records) {
  if (records.length === 0) return "";
  const headers = Object.keys(records[0]);
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [
    headers.join(","),
    ...records.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

async function retry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

function findFrame(page, pred) {
  for (const frame of page.frames()) {
    if (pred(frame)) return frame;
  }
  return null;
}

async function loginGuest(page) {
  await retry(() =>
    page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 90000 })
  );
  await page.locator('input[value*="Guest" i]').first().click();
  await page.waitForTimeout(2000);
  await page.frame({ name: "bodyframe" }).locator('input[type="button"][value="Accept"]').click();
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const overlay = document.getElementById("disablediv");
    if (overlay) overlay.style.visibility = "hidden";
  });
  await page.frame({ name: "bodyframe" }).locator('[datagrid-row-index="0"]').click();
  await page.waitForTimeout(6000);
}

function getSearchFrames(page) {
  const criteria = findFrame(page, (f) => f.url().includes("searchCriteria.do"));
  const dyn = findFrame(page, (f) => f.url().includes("dynCriteria.do"));
  const body = page.frame({ name: "bodyframe" });
  if (!criteria || !dyn || !body) {
    throw new Error("Could not locate CountyFusion search frames");
  }
  return { criteria, dyn, body };
}

async function selectDocumentTypes(criteria, typeNames) {
  await criteria.evaluate((names) => {
    const root = $("#instTree").tree("getRoot");
    $("#instTree").tree("uncheck", root.target);
    $("#instTree").tree("collapseAll", root.target);
    $("#instTree").tree("expand", root.target);

    function walk(node) {
      for (const child of $("#instTree").tree("getChildren", node.target)) {
        const label = (child.text || "").replace(/\s+/g, " ").trim().toUpperCase();
        if (label === "LIENS") $("#instTree").tree("expand", child.target);
        walk(child);
      }
    }
    walk(root);

    function checkMatches(node) {
      for (const child of $("#instTree").tree("getChildren", node.target)) {
        const label = (child.text || "").replace(/\s+/g, " ").trim().toUpperCase();
        if (names.some((n) => label === n.toUpperCase())) {
          $("#instTree").tree("check", child.target);
        }
        checkMatches(child);
      }
    }
    checkMatches(root);
  }, typeNames);

  const checked = await criteria.evaluate(() =>
    $("#instTree")
      .tree("getChecked")
      .map((n) => n.text)
  );
  if (checked.length === 0) {
    throw new Error(`No document types selected (wanted: ${typeNames.join(", ")})`);
  }
  return checked;
}

async function setDateRange(dyn, from, to) {
  await dyn.evaluate(({ from, to }) => {
    $("#FROMDATE").datebox("setValue", from);
    $("#TODATE").datebox("setValue", to);
  }, { from, to });
}

async function setRecordsPerPage(criteria, value) {
  await criteria.evaluate((recs) => {
    $("#RECSPERPAGE").combobox("setValue", recs);
  }, value);
}

async function snapshotResults(body) {
  return body.evaluate(() => {
    const rf = window.frames["resultFrame"];
    const list = rf?.frames?.["resultListFrame"];
    const rfText = rf?.document?.body?.innerText ?? "";
    const rfNoRecords = /no records found|your search returned no results|0 records found|no documents found|search found no/i.test(
      rfText
    );

    if (!list) {
      const count = rf?.searchResultObj?.resultsCount;
      if (rfNoRecords || count === 0) {
        return { ready: true, count: 0, loaded: 0, firstInst: "", url: "", noRecords: true, text: rfText.slice(0, 200) };
      }
      if (typeof count === "number") {
        return { ready: true, count, loaded: 0, firstInst: "", url: "", noRecords: count === 0, text: rfText.slice(0, 200) };
      }
      return { ready: false, text: rfText.slice(0, 120) };
    }

    const text = list.document?.body?.innerText ?? "";
    const count = list.parent?.searchResultObj?.resultsCount ?? rf?.searchResultObj?.resultsCount;
    const loaded = list.documentRowInfo?.length ?? 0;
    const firstInst = list.documentRowInfo?.[0]?.instNum ?? "";
    const url = list.location?.href ?? "";
    const noRecords =
      rfNoRecords ||
      /no records found|your search returned no results|0 records found|no documents found|search found no/i.test(
        text
      );
    return { ready: true, count, loaded, firstInst, url, noRecords, text: text.slice(0, 200) };
  });
}

function resultFingerprint(snap) {
  if (!snap?.ready) return "";
  return `${snap.url}|${snap.count ?? "?"}|${snap.loaded}|${snap.firstInst}|${snap.noRecords}`;
}

async function waitForNewResults(body, previousFingerprint, timeoutMs = 120000) {
  const started = Date.now();
  let stableKey = null;
  let stableSince = 0;

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const snap = await snapshotResults(body);
    if (!snap.ready) continue;

    if (snap.noRecords || (typeof snap.count === "number" && snap.count === 0)) {
      return { count: 0, loaded: 0, snap };
    }

    const key = resultFingerprint(snap);
    const hasData = typeof snap.count === "number" ? snap.count > 0 : snap.loaded > 0;

    if (!hasData && key !== previousFingerprint) {
      if (key === stableKey && Date.now() - stableSince >= 3000) {
        return { count: 0, loaded: 0, snap };
      }
      if (key !== stableKey) {
        stableKey = key;
        stableSince = Date.now();
      }
      continue;
    }

    if (!hasData) continue;
    if (key === previousFingerprint) continue;

    if (key === stableKey) {
      if (Date.now() - stableSince >= 3000) {
        return { count: snap.count ?? snap.loaded, loaded: snap.loaded, snap };
      }
    } else {
      stableKey = key;
      stableSince = Date.now();
    }
  }

  throw new Error("Timed out waiting for recorder search results");
}

async function runSearch(criteria, body, previousFingerprint) {
  await criteria.evaluate(() => {
    executing = false;
    executeCommand("search");
  });
  return waitForNewResults(body, previousFingerprint);
}

async function extractResultRows(body) {
  return body.evaluate(() => {
    const list = window.frames["resultFrame"]?.frames["resultListFrame"];
    if (!list) return [];

    function cellText(row, field, multiline = false) {
      const td = row.querySelector(`td[field="${field}"]`);
      if (!td) return "";
      if (multiline) {
        return (td.innerHTML || "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/\u00a0/g, " ")
          .split("\n")
          .map((s) => s.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("; ");
      }
      return (td.innerText || td.textContent || "").replace(/\s+/g, " ").trim();
    }

    const rows = [];
    for (const tr of list.document.querySelectorAll("tr[datagrid-row-index]")) {
      const inner = tr.querySelector("table tbody tr");
      if (!inner) continue;
      rows.push({
        instrument_id: inner.querySelector('input[name="navCB"]')?.value ?? null,
        instrument_number: cellText(inner, "2"),
        book: cellText(inner, "3"),
        page: cellText(inner, "4"),
        document_type: cellText(inner, "5"),
        grantor_names: cellText(inner, "7", true),
        defendant_names: cellText(inner, "9", true),
        recorded_date: cellText(inner, "10"),
        legal_description: cellText(inner, "11"),
        reference: cellText(inner, "12"),
      });
    }
    return rows;
  });
}

async function scrapeLisPendens(ranges) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const allRecords = [];
  let fingerprint = "";

  try {
    console.error("Logging into Richland County Recorder (guest)...");
    await loginGuest(page);

    const { criteria, dyn, body } = getSearchFrames(page);

    console.error(`Selecting document types: ${DOC_TYPES.join(", ")}`);
    const checked = await selectDocumentTypes(criteria, DOC_TYPES);
    console.error(`  Checked: ${checked.join(", ")}`);
    await setRecordsPerPage(criteria, RECORDS_PER_PAGE);

    fingerprint = resultFingerprint(await snapshotResults(body));

    for (const range of ranges) {
      console.error(`Searching ${range.label} (${range.from} – ${range.to})...`);
      await setDateRange(dyn, range.from, range.to);

      const { count, loaded } = await runSearch(criteria, body, fingerprint);
      fingerprint = resultFingerprint(await snapshotResults(body));

      console.error(`  ${count ?? loaded} filing(s) (${loaded} on page)`);
      if (typeof count === "number" && count > loaded) {
        console.error(`  Warning: ${count - loaded} result(s) may need pagination`);
      }

      const rawRows = await extractResultRows(body);
      allRecords.push(...rawRows.map(normalizeRecord));
    }

    return dedupeRecords(allRecords);
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseArgs();
  const ranges = buildDateRanges(options);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const range = ranges[0];
  if (options.mode === "all") {
    console.error(
      `Full history scrape: ${ranges.length} year-range(s) from ${options.startYear} to today`
    );
  } else {
    console.error(`Recorded date range: ${range.from} – ${range.to}`);
  }

  const delta = await scrapeLisPendens(ranges);
  const canonical = mergeByKey(
    loadCanonicalRecords("lis-pendens-canonical.json"),
    delta,
    (r) => r.instrument_number ?? r.instrument_id
  );

  const { deltaJson, deltaCsv, canonicalJson, canonicalCsv } = writeRunOutputs(
    "lis-pendens",
    delta,
    canonical
  );

  markSourceRun(SOURCE_ID, { last_from_date: range.from, last_to_date: range.to });

  console.error(`Fetched this run:  ${delta.length}`);
  console.error(`Canonical total:   ${canonical.length}`);
  console.error(`Wrote ${deltaJson}`);
  console.error(`Wrote ${deltaCsv}`);
  console.error(`Wrote ${canonicalJson}`);
  console.error(`Wrote ${canonicalCsv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Scrape Richland County OH pre-foreclosure / sheriff sale listings.
 *
 * Sources:
 *  - RealAuction bank foreclosure auctions (primary)
 *  - County sheriff page tax foreclosure table (when listed)
 *
 * Usage: node scripts/scrape-pre-foreclosure.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import {
  incrementalFromUsDate,
  markSourceRun,
  mergeByKey,
  loadCanonicalRecords,
  writeRunOutputs,
  onOrAfterUsDate,
  parseUsDate,
  fmtUsDate,
} from "./scrape-state.mjs";
import { paths } from "../src/core/county-context.mjs";

const p = paths();
const REALAUCTION_BASE = "https://richland.sheriffsaleauction.ohio.gov";
const COUNTY_SHERIFF_URL = "https://www.richlandcountyoh.gov/sheriffsales";
const PREVIEW_URL = `${REALAUCTION_BASE}/index.cfm?zaction=AUCTION&zmethod=PREVIEW`;
const SOURCE_ID = "pre-foreclosure";

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function splitCityZip(text) {
  const value = clean(text);
  const m = value.match(/^(.+?)\s*,?\s*([A-Z]{2})?\s*(\d{5}(?:-\d{4})?)?$/i);
  if (!m) return { city: value || null, state: null, zip: null };
  return {
    city: clean(m[1].replace(/,\s*$/, "")) || null,
    state: m[2]?.toUpperCase() ?? null,
    zip: m[3] ?? null,
  };
}

function normalizeRecord(raw) {
  const { city, state, zip } = splitCityZip(raw.city_state_zip);
  return {
    source: raw.source ?? "realauction",
    auction_date_label: raw.auction_date_label ?? null,
    auction_status: raw.auction_status ?? null,
    auction_datetime: raw.auction_datetime ?? null,
    auction_amount: parseMoney(raw.auction_amount),
    sold_to: raw.sold_to ?? null,
    case_status: raw.case_status ?? null,
    case_number: raw.case_number ?? null,
    parcel_id: raw.parcel_id ?? null,
    property_address: raw.property_address ?? null,
    city,
    state,
    zip,
    appraised_value: parseMoney(raw.appraised_value),
    opening_bid: parseMoney(raw.opening_bid),
    deposit_requirement: parseMoney(raw.deposit_requirement),
    sale_date: raw.sale_date ?? null,
    canceled: raw.canceled ?? null,
    description: raw.description ?? null,
    listing_url: raw.listing_url ?? null,
  };
}

function parseAuctionItems(html, listingUrl) {
  const $ = cheerio.load(html);
  const records = [];

  $(".AUCTION_ITEM").each((_, el) => {
    const item = $(el);
    const statsLabel = clean(item.find(".ASTAT_MSGA.ASTAT_LBL").first().text());
    const statsData = clean(item.find(".ASTAT_MSGB.Astat_DATA").first().text());
    const amount = clean(item.find(".ASTAT_MSGD.Astat_DATA").first().text());
    const soldTo = clean(item.find(".ASTAT_MSG_SOLDTO_MSG.Astat_DATA").first().text());

    let auction_status = statsLabel.replace(/^Auction\s+/i, "") || statsLabel;
    let auction_datetime = null;
    if (/^sold$/i.test(auction_status)) {
      auction_status = "Sold";
      auction_datetime = statsData;
    } else if (/^status$/i.test(auction_status)) {
      auction_status = statsData;
    } else if (statsLabel) {
      auction_status = statsData || statsLabel;
    }

    const fields = {};
    let addressLine2 = null;
    item.find(".ad_tab tr").each((__, tr) => {
      const label = clean($(tr).find("th.AD_LBL").text()).replace(/:$/, "").toLowerCase();
      const value = clean($(tr).find("td.AD_DTA").text());
      if (!label && value) addressLine2 = value;
      else if (label) fields[label] = value;
    });

    records.push(
      normalizeRecord({
        source: "realauction",
        auction_date_label: clean($(".BLHeaderDateDisplay").first().text()) || null,
        auction_status,
        auction_datetime,
        auction_amount: amount || null,
        sold_to: soldTo || null,
        case_status: fields["case status"] ?? null,
        case_number: fields["case #"] ?? null,
        parcel_id: fields["parcel id"] ?? null,
        property_address: fields["property address"] ?? null,
        city_state_zip: addressLine2,
        appraised_value: fields["appraised value"] ?? null,
        opening_bid: fields["opening bid"] ?? null,
        deposit_requirement: fields["deposit requirement"] ?? null,
        listing_url: listingUrl,
      })
    );
  });

  return records;
}

function discoverPreviewUrls(html, currentUrl) {
  const $ = cheerio.load(html);
  const urls = new Set([currentUrl]);

  $("a[href*='zmethod=PREVIEW']").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    urls.add(new URL(href, REALAUCTION_BASE).toString());
  });

  return [...urls];
}

function auctionDateFromUrl(url) {
  const m = url.match(/AuctionDate=(\d{2}\/\d{2}\/\d{4})/i);
  return m?.[1] ?? null;
}

function auctionDateFromLabel(label) {
  const m = clean(label).match(/(\w+ \d{1,2}, \d{4})/);
  if (!m) return null;
  const parsed = new Date(m[1]);
  return Number.isNaN(parsed.getTime()) ? null : fmtUsDate(parsed);
}

function recordAuctionUsDate(record) {
  const fromLabel = auctionDateFromLabel(record.auction_date_label);
  if (fromLabel) return fromLabel;
  const dt = clean(record.auction_datetime);
  const m = dt.match(/^(\d{2}\/\d{2}\/\d{4})/);
  return m?.[1] ?? null;
}

function filterPreviewUrls(urls, sinceUsDate) {
  if (!sinceUsDate) return urls;
  return urls.filter((url) => {
    const d = auctionDateFromUrl(url);
    if (!d) return true;
    return onOrAfterUsDate(d, sinceUsDate);
  });
}

function filterRecordsSince(records, sinceUsDate) {
  if (!sinceUsDate) return records;
  return records.filter((r) => onOrAfterUsDate(recordAuctionUsDate(r), sinceUsDate));
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter((r) => {
    const key = [r.case_number, r.parcel_id, r.auction_date_label, r.auction_datetime, r.property_address]
      .filter(Boolean)
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseCountySheriffHtml(html) {
  const $ = cheerio.load(html);
  const records = [];
  const bodyText = clean($("body").text());

  if (/No NEW Sales at this time/i.test(bodyText)) {
    return { records: [], note: "No tax foreclosure sales listed on county page." };
  }

  $("table").each((_, table) => {
    const headers = [];
    $(table)
      .find("tr")
      .first()
      .find("th, td")
      .each((__, cell) => headers.push(clean($(cell).text()).toLowerCase()));

    if (!headers.some((h) => h.includes("case") || h.includes("address"))) return;

    $(table)
      .find("tr")
      .slice(1)
      .each((__, row) => {
        const cells = $(row)
          .find("td")
          .map((___, td) => clean($(td).text()))
          .get();
        if (cells.length < 3) return;

        const rowObj = {};
        headers.forEach((h, i) => {
          if (cells[i]) rowObj[h] = cells[i];
        });

        const cityState = rowObj["city-state"] ?? rowObj.city ?? "";
        records.push(
          normalizeRecord({
            source: "county_tax_foreclosure",
            sale_date: rowObj["sale date"] ?? null,
            case_number: rowObj["case no"] ?? rowObj.case ?? null,
            property_address: rowObj.address ?? null,
            city_state_zip: cityState,
            appraised_value: rowObj.appraisal ?? rowObj["appraised value"],
            canceled: rowObj.canceled ?? null,
            description: rowObj.description ?? null,
          })
        );
      });
  });

  return { records: dedupeRecords(records), note: null };
}

async function createBrowserPage() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return { browser, page: await context.newPage() };
}

async function fetchHtml(page, url, { warmup = false } = {}) {
  const go = async (target) => {
    const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    return resp;
  };

  if (warmup) {
    await retry(() => go(`${REALAUCTION_BASE}/index.cfm?zaction=home&zmethod=welcome`), 3);
    await page.waitForTimeout(1500);
  }

  const resp = await retry(() => go(url), 3);

  const title = await page.title();
  const html = await page.content();
  const text = await page.innerText("body");

  if (/403 Forbidden/i.test(title) || /403 Forbidden/i.test(text)) {
    throw new Error(`Blocked (403) fetching ${url}`);
  }

  return { status: resp?.status() ?? null, html, text, title };
}

async function retry(fn, attempts) {
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

async function scrapeRealAuction(sinceUsDate) {
  const { browser, page } = await createBrowserPage();
  const allRecords = [];

  try {
    console.error("Fetching RealAuction preview (current)...");
    const first = await fetchHtml(page, PREVIEW_URL, { warmup: true });
    console.error(`  ${first.title}`);

    let previewUrls = discoverPreviewUrls(first.html, PREVIEW_URL);
    if (sinceUsDate) {
      previewUrls = filterPreviewUrls(previewUrls, sinceUsDate);
      console.error(`  ${previewUrls.length} auction date page(s) since ${sinceUsDate}`);
    } else {
      console.error(`  Found ${previewUrls.length} auction date page(s)`);
    }

    for (const url of previewUrls) {
      const { html, title } =
        url === PREVIEW_URL ? first : await fetchHtml(page, url);
      const records = parseAuctionItems(html, url);
      console.error(`  ${url.split("AuctionDate=")[1] ?? "current"}: ${records.length} records (${title})`);
      allRecords.push(...records);
    }
  } finally {
    await browser.close();
  }

  return dedupeRecords(filterRecordsSince(allRecords, sinceUsDate));
}

async function scrapeCountyTaxForeclosure() {
  const { browser, page } = await createBrowserPage();
  try {
    console.error("Fetching county sheriff sales page...");
    const resp = await page.goto(COUNTY_SHERIFF_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);
    const { records, note } = parseCountySheriffHtml(await page.content());
    if (note) console.error(`  ${note}`);
    else console.error(`  Parsed ${records.length} tax foreclosure records`);
    return { records, status: resp?.status() ?? null, note };
  } finally {
    await browser.close();
  }
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

async function main() {
  fs.mkdirSync(p.dataRoot, { recursive: true });
  const force = process.argv.includes("--force");
  const sinceUsDate = force ? `01/01/${new Date().getFullYear()}` : incrementalFromUsDate(SOURCE_ID);

  console.error(`Auction dates on or after: ${sinceUsDate}`);

  const bankForeclosures = await scrapeRealAuction(sinceUsDate);
  let county = { records: [], note: null };
  try {
    county = await scrapeCountyTaxForeclosure();
    county.records = filterRecordsSince(county.records, sinceUsDate);
  } catch (err) {
    console.error(`  County page skipped: ${err.message}`);
    county.note = "County sheriff page unavailable during scrape.";
  }

  const delta = dedupeRecords([...bankForeclosures, ...county.records]);
  const canonical = mergeByKey(
    loadCanonicalRecords("pre-foreclosure-canonical.json"),
    delta,
    (r) =>
      [r.case_number, r.parcel_id, r.auction_date_label, r.auction_datetime, r.property_address]
        .filter(Boolean)
        .join("|")
  );

  const { deltaJson, deltaCsv, canonicalJson, canonicalCsv } = writeRunOutputs(
    "pre-foreclosure",
    delta,
    canonical
  );

  markSourceRun(SOURCE_ID, { last_since_date: sinceUsDate });

  console.error(`\nFetched this run:  ${delta.length}`);
  console.error(`  Bank foreclosure: ${bankForeclosures.length}`);
  console.error(`  Tax foreclosure:  ${county.records.length}`);
  console.error(`Canonical total:   ${canonical.length}`);
  if (county.note) console.error(`  Note: ${county.note}`);
  console.error(`Wrote ${deltaJson}`);
  console.error(`Wrote ${deltaCsv}`);
  console.error(`Wrote ${canonicalJson}`);
  console.error(`Wrote ${canonicalCsv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

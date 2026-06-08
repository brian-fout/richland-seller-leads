/**
 * Richland County Beacon (Schneider) parcel detail helpers.
 *
 * Beacon CAMA is more current than Parcel_CAMA GIS for owner/sales.
 * Headed Playwright passes Cloudflare; save session for batch runs.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import { paths } from "../src/core/county-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BEACON_APP = {
  appId: "1067",
  layerId: "25465",
  detailPageTypeId: "4",
  detailPageId: "10349",
  searchPageId: "10347",
  searchPageTypeId: "2",
};

export const BEACON_SEARCH_URL =
  "https://beacon.schneidercorp.com/Application.aspx?AppID=1067&LayerID=25465&PageTypeID=2&PageID=10347";

export function beaconSessionPath() {
  return paths().beaconSession;
}

export function parcelIdToKeyValue(parcelId) {
  return String(parcelId ?? "")
    .replace(/-/g, "")
    .trim();
}

export function keyValueToParcelId(keyValue) {
  const digits = String(keyValue ?? "").replace(/\D/g, "");
  if (digits.length !== 13) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 8)}-${digits.slice(8, 10)}-${digits.slice(10, 13)}`;
}

export function beaconDetailUrl(keyValue, q = null) {
  const params = new URLSearchParams({
    AppID: BEACON_APP.appId,
    LayerID: BEACON_APP.layerId,
    PageTypeID: BEACON_APP.detailPageTypeId,
    PageID: BEACON_APP.detailPageId,
    KeyValue: parcelIdToKeyValue(keyValue),
  });
  if (q) params.set("Q", String(q));
  return `https://beacon.schneidercorp.com/Application.aspx?${params}`;
}

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function labelValuePairs($, root) {
  const pairs = {};
  $(root)
    .find("span, label, th, td, div")
    .each((_, el) => {
      const id = ($(el).attr("id") || "").toLowerCase();
      const text = clean($(el).text());
      if (!text) return;
      if (id.includes("lbl") || id.includes("label")) {
        const next = clean($(el).next().text());
        if (next && next !== text && text.length < 80) pairs[text] = next;
      }
    });
  return pairs;
}

function tableRows($, table) {
  const headers = [];
  $(table)
    .find("tr")
    .first()
    .find("th, td")
    .each((_, cell) => headers.push(clean($(cell).text())));

  const rows = [];
  $(table)
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      const cells = $(tr)
        .find("th, td")
        .map((__, td) => clean($(td).text()))
        .get()
        .filter(Boolean);
      if (!cells.length) return;
      if (headers.length && cells.length === headers.length) {
        const row = {};
        headers.forEach((h, i) => {
          row[h] = cells[i];
        });
        rows.push(row);
      } else {
        rows.push({ cells });
      }
    });
  return rows;
}

function parseValuationTable($, table) {
  const values = {};
  let afterAssessedTotal = false;
  let landAppraised = null;
  let buildingAppraised = null;

  $(table)
    .find("tbody tr")
    .each((_, tr) => {
      const label = clean($(tr).find("th[scope='row']").first().text());
      const current = clean($(tr).find("td.value-column").first().text());
      if (!label || !current) return;
      values[label] = current;

      if (/total value \(assessed/i.test(label)) afterAssessedTotal = true;
      if (/^land value$/i.test(label) && afterAssessedTotal) landAppraised = parseMoney(current);
      if (/^building value$/i.test(label) && afterAssessedTotal) buildingAppraised = parseMoney(current);
    });

  return {
    rows: values,
    land_value: landAppraised,
    building_value: buildingAppraised,
    total_value: parseMoney(values["Total Value (Appraised 100%)"] ?? null),
    assessed_value: parseMoney(values["Total Value (Assessed 35%)"] ?? null),
  };
}

function parseBeaconSalesTable($, table) {
  const sales = [];
  $(table)
    .find("tbody tr")
    .each((_, tr) => {
      const dateCell = $(tr).find("th[scope='row']").first().clone();
      dateCell.find(".footable-toggle").remove();
      const date = clean(dateCell.text());
      const tds = $(tr).find("td");
      if (!date || tds.length < 4) return;
      sales.push({
        date,
        book: clean($(tds).eq(0).text()) || null,
        page: clean($(tds).eq(1).text()) || null,
        grantor: clean($(tds).eq(2).text()) || null,
        grantee: clean($(tds).eq(3).text()) || null,
        price: parseMoney(clean($(tds).eq(4).text())),
        instrument: clean($(tds).eq(5).text()) || null,
        validity: clean($(tds).eq(6).text()) || null,
        sale_type: clean($(tds).eq(7).text()) || null,
      });
    });
  return sales;
}

export function parseBeaconDetailHtml(html, parcelId = null) {
  const $ = cheerio.load(html);
  const bodyText = clean($("body").text());

  if (isBeaconIpBanHtml(html)) {
    return { status: "blocked", parcel_id: parcelId, error: "ip_banned", title: clean($("title").text()) };
  }

  if (
    /Just a moment|security verification|turnstile|cf-turnstile|challenge-platform|verify you are human|cf-challenge/i.test(
      `${bodyText} ${html}`
    )
  ) {
    return { status: "blocked", parcel_id: parcelId, error: "cloudflare" };
  }

  const title = clean($("title").text());
  const keyValueMatch = html.match(/KeyValue[=:]"?(\d{13})/i);
  const keyValue = keyValueMatch?.[1] ?? null;

  const result = {
    status: "ok",
    parcel_id: parcelId ?? (keyValue ? keyValueToParcelId(keyValue) : null),
    key_value: keyValue,
    title,
    owner_name: null,
    owner_name_2: null,
    mailing_address: null,
    parcel_address: null,
    city: null,
    zip: null,
    land_value: null,
    building_value: null,
    total_value: null,
    assessed_value: null,
    market_value: null,
    acres: null,
    year_built: null,
    square_footage: null,
    bedrooms: null,
    full_bath: null,
    land_use: null,
    sales: [],
    valuation: {},
    fields: {},
    fetched_at: new Date().toISOString(),
  };

  result.parcel_address = clean($('span[editkey*="PROPERTYADDRESS"]').first().text()) || null;

  const owner1 = clean($("[id*='sprLnkOwnerName1'][id*='lblSearch']").first().text());
  const owner2 = clean($("[id*='sprLblOwnerName2']").first().text());
  result.owner_name = owner1 || null;
  result.owner_name_2 = owner2 || null;
  if (
    owner1 &&
    owner2 &&
    !/limited liability|corporation|partnership|trust|estate|company|inc\.?|llc/i.test(owner2)
  ) {
    result.owner_name = `${owner1} ${owner2}`.replace(/\s+/g, " ").trim();
  }

  const mailingHtml = clean($("[id*='lblMailing']").first().html() ?? "");
  if (mailingHtml) {
    result.mailing_address = mailingHtml
      .replace(/<br\s*\/?>/gi, ", ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const valuationTable = $("#ctlBodyPane_ctl02_ctl01_grdValuation_grdYearData, table[id*='grdValuation']").first();
  if (valuationTable.length) {
    const valuation = parseValuationTable($, valuationTable);
    result.valuation = valuation.rows;
    Object.assign(result.fields, valuation.rows);
    result.land_value = valuation.land_value;
    result.building_value = valuation.building_value;
    result.total_value = valuation.total_value;
    result.assessed_value = valuation.assessed_value;
  }

  const salesTable = $("#ctlBodyPane_ctl12_ctl01_gvwSales, table[id*='gvwSales']").first();
  if (salesTable.length) {
    result.sales = parseBeaconSalesTable($, salesTable);
  }

  $("strong").each((_, el) => {
    const label = clean($(el).text()).toLowerCase();
    const value = clean($(el).parent().next().text() || $(el).closest("div").find("span").last().text());
    if (label === "year built" && value) result.year_built = parseIntValue(value);
    if (/living area|square feet|finished area/i.test(label) && value) result.square_footage = parseIntValue(value);
    if (/bedroom/i.test(label) && value) result.bedrooms = parseIntValue(value);
    if (/full bath/i.test(label) && value) result.full_bath = parseIntValue(value);
    if (/land use|use code/i.test(label) && value) result.land_use = value;
    if (/acres/i.test(label) && value) result.acres = parseNumber(value);
  });

  if (!result.owner_name && !result.parcel_address && result.sales.length === 0) {
    return { status: "parse_failed", parcel_id: parcelId, error: "no fields extracted", title };
  }

  return result;
}

function parseMoney(value) {
  const n = parseFloat(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseNumber(value) {
  const n = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseIntValue(value) {
  const n = parseInt(String(value).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function loadBeaconSession() {
  const sessionPath = beaconSessionPath();
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch {
    return null;
  }
}

export function saveBeaconSession(storageState) {
  fs.writeFileSync(beaconSessionPath(), JSON.stringify(storageState, null, 2));
}

export async function createBeaconBrowser({ headed = false } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: !headed,
    slowMo: headed ? 50 : 0,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const session = loadBeaconSession();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
    storageState: session ?? undefined,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function pageHtml(page) {
  return page.content().catch(() => "");
}

export function isBeaconIpBanHtml(html) {
  const text = clean(cheerio.load(html)("body").text());
  return /not authorized to view this website|patterns of activity that do not represent regular end user|automated data mining|automated data collection will be detected/i.test(
    text
  );
}

export async function isBeaconIpBanned(page) {
  return isBeaconIpBanHtml(await pageHtml(page));
}

export async function isBeaconReadyPage(page) {
  const html = await pageHtml(page);
  if (isBeaconIpBanHtml(html)) return false;
  return /grdValuation|PROPERTYADDRESS|gvwSales|ctlBodyPane|Beacon - Richland County/i.test(html);
}

export async function isCloudflarePage(page) {
  if (await isBeaconReadyPage(page)) return false;

  const html = await pageHtml(page);
  const text = clean(cheerio.load(html)("body").text());
  const title = clean(cheerio.load(html)("title").text());

  return /Just a moment|Checking your browser|cf-browser-verification|cf-challenge-running|Attention Required/i.test(
    `${title} ${text} ${html}`
  );
}

export async function waitForCloudflareCleared(page, { headed = true } = {}) {
  if (!(await isCloudflarePage(page))) return true;

  if (headed) {
    console.error("");
    console.error("  ============================================================");
    console.error("  CLOUDFLARE CHECK — complete the challenge in the browser.");
    console.error("  Batch is PAUSED until it clears. Do not close the window.");
    console.error("  ============================================================");
  }

  let waited = 0;
  while (await isCloudflarePage(page)) {
    await page.waitForTimeout(2000);
    waited += 2000;
    if (headed && waited % 15000 === 0) {
      console.error(`  Still waiting for Cloudflare... (${Math.round(waited / 1000)}s)`);
    }
  }

  if (headed && waited > 0) {
    console.error("  Cloudflare cleared — resuming.");
  }
  await page.waitForTimeout(1500);
  return true;
}

export async function acceptBeaconDisclaimer(page) {
  const accept = page
    .locator('button:has-text("I Accept"), input[value*="Accept" i], a:has-text("I Accept")')
    .first();
  if (await accept.isVisible().catch(() => false)) {
    await accept.click();
    await page.waitForTimeout(1200);
  }
}

export async function warmBeaconSession(page, { headed = true } = {}) {
  await page.goto(BEACON_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await waitForCloudflareCleared(page, { headed });
  await acceptBeaconDisclaimer(page);
}

export async function fetchBeaconParcel(
  page,
  parcelId,
  { acceptDisclaimer = true, direct = false, waitMs = 1200, headed = true } = {}
) {
  const keyValue = parcelIdToKeyValue(parcelId);
  const detailUrl = beaconDetailUrl(keyValue);

  if (direct) {
    await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (await isCloudflarePage(page)) {
      await waitForCloudflareCleared(page, { headed });
    }
    if (!(await isBeaconReadyPage(page))) {
      await page.waitForTimeout(waitMs);
    }
  } else {
    if (acceptDisclaimer) {
      await warmBeaconSession(page);
    }

    const searchInput = page
      .locator('input[placeholder*="parcel" i], input[id*="Parcel" i], input[name*="Parcel" i]')
      .first();
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(parcelId);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2500);
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => null);
    }

    let url = page.url();
    if (!url.includes("KeyValue=")) {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      await waitForCloudflareCleared(page, { headed });
      await page.waitForTimeout(2500);
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => null);
      url = page.url();
    }
  }

  if (await isCloudflarePage(page)) {
    await waitForCloudflareCleared(page, { headed });
  }

  const url = page.url();
  const html = await page.content();
  let parsed = parseBeaconDetailHtml(html, parcelId);
  if (parsed.status === "parse_failed" && (await isCloudflarePage(page))) {
    parsed = { status: "blocked", parcel_id: parcelId, error: "cloudflare" };
  }
  parsed.source_url = url;
  parsed.key_value = keyValue;
  return parsed;
}

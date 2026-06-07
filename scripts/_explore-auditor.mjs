import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const SEARCH_URL =
  "https://beacon.schneidercorp.com/Application.aspx?AppID=1067&LayerID=25465&PageTypeID=2&PageID=10347";
const SAMPLE_PARCEL = "027-06-078-13-001"; // from tax lien list

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("response", async (resp) => {
  const url = resp.url();
  if (/beacon|schneidercorp|api|ajax|search|parcel/i.test(url) && resp.request().method() !== "GET") {
    try {
      const ct = resp.headers()["content-type"] || "";
      if (/json|text|html/i.test(ct)) {
        const text = await resp.text();
        if (text.length > 20 && text.length < 300000) {
          const safe = url.replace(/[^a-z0-9]+/gi, "-").slice(-60);
          fs.writeFileSync(path.join(OUT, `_auditor-post-${Date.now()}-${safe}.txt`), text.slice(0, 80000));
          console.log("POST", resp.status(), url.slice(0, 100));
        }
      }
    } catch {
      // ignore
    }
  }
});

console.log("1. Loading search page...");
await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(2000);
fs.writeFileSync(path.join(OUT, "_auditor-search.html"), await page.content());

const title = await page.title();
console.log("title:", title);
const bodyText = await page.innerText("body");
console.log("body snippet:", bodyText.slice(0, 800));

// Disclaimer / accept
const acceptBtn = page.locator('input[value="Accept"], button:has-text("Accept"), a:has-text("Accept")').first();
if (await acceptBtn.isVisible().catch(() => false)) {
  console.log("2. Clicking Accept disclaimer...");
  await acceptBtn.click();
  await page.waitForTimeout(2000);
  fs.writeFileSync(path.join(OUT, "_auditor-after-accept.html"), await page.content());
}

// CAPTCHA check
const hasCaptcha = await page.locator('iframe[src*="recaptcha"], .g-recaptcha, #captcha').count();
console.log("captcha elements:", hasCaptcha);

// Search by parcel
console.log("3. Searching parcel", SAMPLE_PARCEL);
const parcelInput = page.locator(
  'input[placeholder*="parcel" i], input[id*="Parcel" i], input[name*="Parcel" i], input[type="search"]'
).first();
await parcelInput.waitFor({ timeout: 30000 }).catch(() => null);

if (await parcelInput.isVisible().catch(() => false)) {
  await parcelInput.fill(SAMPLE_PARCEL);
  await page.keyboard.press("Enter");
} else {
  // try tab/link for parcel search
  const parcelTab = page.locator('a:has-text("Parcel"), button:has-text("Parcel")').first();
  if (await parcelTab.isVisible().catch(() => false)) {
    await parcelTab.click();
    await page.waitForTimeout(1000);
  }
  const inputs = await page.locator("input").evaluateAll((els) =>
    els.map((el) => ({ id: el.id, name: el.name, placeholder: el.placeholder, type: el.type }))
  );
  console.log("inputs:", JSON.stringify(inputs.slice(0, 20), null, 2));
  const inp = page.locator("input[type='text']").first();
  await inp.fill(SAMPLE_PARCEL);
  await page.keyboard.press("Enter");
}

await page.waitForTimeout(4000);
await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => null);
fs.writeFileSync(path.join(OUT, "_auditor-search-results.html"), await page.content());
console.log("results url:", page.url());
console.log("results body:", (await page.innerText("body")).slice(0, 2000));

// Click first result if on search results page
const detailLink = page.locator('a[href*="KeyValue"], a[href*="PageID=10348"], a[href*="Parcel"]').first();
if (await detailLink.isVisible().catch(() => false)) {
  console.log("4. Opening first result...");
  await detailLink.click();
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => null);
}

// Or direct parcel URL pattern
if (!/KeyValue|PageID=10348/i.test(page.url())) {
  console.log("4b. Trying direct parcel detail URL...");
  const directUrl = `${SEARCH_URL}&Q=${encodeURIComponent(SAMPLE_PARCEL)}&QB=PARCEL`;
  await page.goto(directUrl, { waitUntil: "networkidle", timeout: 120000 }).catch(() => null);
  await page.waitForTimeout(3000);
}

fs.writeFileSync(path.join(OUT, "_auditor-parcel-detail.html"), await page.content());
const detailText = await page.innerText("body");
console.log("detail url:", page.url());
console.log("detail body:", detailText.slice(0, 6000));

const $ = cheerio.load(await page.content());
const sections = [];
$("h1, h2, h3, h4, .module-title, .tab-title, span[id*='lbl']").each((_, el) => {
  const t = $(el).text().replace(/\s+/g, " ").trim();
  if (/sale|transfer|valuation|owner|address|land|building|tax|history|deed|transfer/i.test(t) && t.length < 80) {
    sections.push(t);
  }
});
console.log("relevant sections:", [...new Set(sections)].slice(0, 40));

// Look for sales/transfer tables
$("table").each((i, table) => {
  const headers = $(table)
    .find("tr")
    .first()
    .find("th, td")
    .map((__, c) => $(c).text().replace(/\s+/g, " ").trim())
    .get();
  if (headers.some((h) => /sale|transfer|date|price|grantor|grantee|deed/i.test(h))) {
    console.log(
      "table",
      i,
      "headers:",
      headers,
      "rows:",
      $(table).find("tr").length
    );
  }
});

await browser.close();
console.log("Done.");

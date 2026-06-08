import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadCookies, BASE_URL } from "./clerk-session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const cookies = JSON.parse(fs.readFileSync(path.join(OUT, "clerk-cookies.json"), "utf8"));

const sample = JSON.parse(fs.readFileSync(path.join(OUT, "clerk-foreclosures-canonical.json"), "utf8"))[0];
console.log("Sample case:", sample.case_number, sample.detail_url);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await loadCookies(ctx);
const page = await ctx.newPage();

// Try detail URL from search results
await page.goto(sample.detail_url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3000);
console.log("\nAfter detail_url goto:");
console.log("URL:", page.url());
console.log("Title:", await page.title());
const body1 = await page.innerText("body");
console.log("Body snippet:", body1.slice(0, 2500));
fs.writeFileSync(path.join(OUT, "_clerk-detail-probe1.html"), await page.content());

// Try case search by number then open detail
await page.goto(`${BASE_URL}/search.page`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(2000);
await page.locator('input[name="caseDscr"]').fill(`${sample.case_number} N`);
await Promise.all([
  page.waitForLoadState("domcontentloaded").catch(() => null),
  page.locator('#caseNumberSearch input[type="submit"]').click(),
]);
await page.waitForTimeout(3000);
console.log("\nAfter case number search:");
console.log("URL:", page.url());
const body2 = await page.innerText("body");
console.log("Body snippet:", body2.slice(0, 2000));

const caseLink = page.locator('a:has-text("2026 CV 0001")').first();
if (await caseLink.count()) {
  await caseLink.click();
  await page.waitForTimeout(3000);
  console.log("\nAfter case link click:");
  console.log("URL:", page.url());
  const body3 = await page.innerText("body");
  console.log("Body snippet:", body3.slice(0, 3500));
  fs.writeFileSync(path.join(OUT, "_clerk-detail-probe2.html"), await page.content());

  const labels = await page.$$eval("label, th, dt, .label, .formLabel", (els) =>
    els
      .map((e) => ({
        tag: e.tagName,
        text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        for: e.getAttribute("for"),
      }))
      .filter((x) => /address|property|parcel|legal|location|street|site/i.test(x.text))
  );
  console.log("\nAddress-related labels:", JSON.stringify(labels, null, 2));
}

await browser.close();

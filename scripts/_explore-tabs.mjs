import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://countyfusion13.kofiletech.us/countyweb";

async function loginGuest(page) {
  await page.goto(`${BASE}/loginDisplay.action?countyname=RichlandOH`, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('input[value*="Guest" i]').first().click();
  await page.waitForTimeout(2000);
  await page.frame({ name: "bodyframe" }).locator('input[type="button"][value="Accept"]').click();
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const d = document.getElementById("disablediv");
    if (d) d.style.visibility = "hidden";
  });
  await page.frame({ name: "bodyframe" }).locator('[datagrid-row-index="0"]').click();
  await page.waitForTimeout(6000);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await loginGuest(page);

const criteria = page.frames().find((f) => f.url().includes("searchCriteria.do"));
const html = await criteria.content();
fs.writeFileSync(path.join(__dirname, "..", "data", "_recorder-criteria.html"), html);

// Extract search type tabs from HTML
const tabMatches = [...html.matchAll(/searchType[=:]\s*[\"']([^\"']+)[\"']/g)].map((m) => m[1]);
console.log("searchType attrs:", [...new Set(tabMatches)]);

const onclickMatches = [...html.matchAll(/setActiveSearch\([^)]+\)/g)].slice(0, 30);
console.log("setActiveSearch calls:", onclickMatches.map((m) => m[0]));

// Read dynCriteria frame and look for instrument type list in JS
const dyn = criteria.childFrames().find((f) => f.url().includes("dynCriteria.do"));
console.log("\nDyn URL:", dyn?.url());
console.log((await dyn?.innerText("body"))?.slice(0, 1000));

// Try clicking tabs in criteria frame if any
const tabs = await criteria.locator(".tabs-title, .tabs li, [role='tab']").all();
console.log("Tab count:", tabs.length);
for (let i = 0; i < Math.min(tabs.length, 15); i++) {
  const t = await tabs[i].innerText().catch(() => "");
  console.log("Tab", i, t);
}

await browser.close();

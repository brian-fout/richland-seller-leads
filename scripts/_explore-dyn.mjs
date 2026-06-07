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

const dyn = page.frames().find((f) => f.url().includes("dynCriteria.do"));
const html = await dyn.content();
fs.writeFileSync(path.join(__dirname, "..", "data", "_dyn-criteria.html"), html);

for (const term of ["filter", "lis", "pendens", "instType", "instrument", "searchType", "popup", "show"]) {
  const re = new RegExp(term, "gi");
  const matches = [...html.matchAll(re)];
  if (matches.length) console.log(term, matches.length);
}

const idx = html.toLowerCase().indexOf("filter");
if (idx >= 0) console.log(html.slice(idx - 200, idx + 800));

// Try clicking image/button near Filter Results
const imgs = await dyn.locator("img, input[type=button], a").all();
for (const el of imgs) {
  const info = await el.evaluate((node) => ({
    tag: node.tagName,
    alt: node.getAttribute("alt"),
    title: node.getAttribute("title"),
    value: node.getAttribute("value"),
    onclick: node.getAttribute("onclick"),
    src: node.getAttribute("src"),
  }));
  if (/filter|search|select|type|inst/i.test(JSON.stringify(info))) console.log(info);
}

await browser.close();

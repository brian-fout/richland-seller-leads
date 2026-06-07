import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const BASE = "https://benchmark.mansfieldcity.com/BenchmarkWeb";

async function setMultiselect(page, selectId, values) {
  await page.evaluate(
    ({ selectId, values }) => {
      const select = document.getElementById(selectId);
      for (const opt of select.options) opt.selected = values.includes(opt.value);
      window.jQuery(`#${selectId}`).multiselect("refresh");
    },
    { selectId, values }
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${BASE}/Home.aspx/Search`, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(1500);
await page.locator("#allCheck").check({ force: true });
await setMultiselect(page, "courTypes", ["6"]);
await setMultiselect(page, "caseTypes", ["6"]);
await page.locator("#openedFrom").fill("01/01/2026");
await page.locator("#openedTo").fill("01/03/2026");
await Promise.all([
  page.waitForURL(/CaseSearch/, { timeout: 120000 }),
  page.locator("#searchButton").click(),
]);
await page.waitForSelector("#gridSearchResults tbody tr", { timeout: 120000 });

await page.locator('a[title="Case Details"]').first().click();
await page.waitForLoadState("networkidle");
fs.writeFileSync(path.join(OUT, "_evict-case-detail.html"), await page.content());
const text = await page.innerText("body");
console.log(text.slice(0, 4000));

const $ = cheerio.load(await page.content());
$("td, th, label, span.detailLabel").each((_, el) => {
  const t = $(el).text().replace(/\s+/g, " ").trim();
  if (/address|property|street|city|zip|filed|opened|date|rent|cause|type/i.test(t) && t.length < 80) {
    console.log("FIELD:", t);
  }
});

await browser.close();

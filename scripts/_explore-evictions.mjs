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

page.on("response", async (resp) => {
  const url = resp.url();
  if (/CaseSearch|CourtCase/i.test(url) && resp.request().method() === "POST") {
    const ct = resp.headers()["content-type"] || "";
    console.log("POST", url, resp.status(), ct);
    try {
      const text = await resp.text();
      fs.writeFileSync(
        path.join(OUT, `_evict-response-${Date.now()}.txt`),
        text.slice(0, 200000)
      );
      if (text.startsWith("{") || text.startsWith("[")) {
        console.log("json snippet:", text.slice(0, 500));
      } else {
        console.log("html/text snippet:", text.slice(0, 500));
      }
    } catch {
      // ignore
    }
  }
});

await page.goto(`${BASE}/Home.aspx/Search`, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(1500);
await page.locator("#allCheck").check({ force: true });
await setMultiselect(page, "courTypes", ["6"]);
await setMultiselect(page, "caseTypes", ["6"]);
await page.locator("#openedFrom").fill("01/01/2026");
await page.locator("#openedTo").fill("01/31/2026");

await Promise.all([
  page.waitForURL(/CaseSearch/, { timeout: 120000 }),
  page.locator("#searchButton").click(),
]);

await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => null);
await page.waitForSelector("#gridSearchResults, .dataTables_empty, table.dataTable", { timeout: 120000 }).catch(() => null);
await page.waitForTimeout(3000);

const html = await page.content();
fs.writeFileSync(path.join(OUT, "_evict-benchmark-results.html"), html);
console.log("url:", page.url());
console.log("body:", (await page.innerText("body")).slice(0, 5000));

const $ = cheerio.load(html);
console.log("rows in grid:", $("#gridSearchResults tbody tr").length);
$("#gridSearchResults tbody tr")
  .slice(0, 5)
  .each((i, tr) => {
    const cells = $(tr)
      .find("td")
      .map((__, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    console.log("row", i, cells);
  });

await browser.close();

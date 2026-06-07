import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

let capturedPost = null;
page.on("request", (req) => {
  if (req.url().includes("Search.aspx/CaseSearch") && req.method() === "POST") {
    capturedPost = {
      url: req.url(),
      headers: req.headers(),
      body: req.postData(),
    };
  }
});

await page.goto(`${BASE}/Home.aspx/Search`, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(1500);
await page.locator("#allCheck").check({ force: true });
await setMultiselect(page, "courTypes", ["6"]);
await setMultiselect(page, "caseTypes", ["6"]);
await page.locator("#openedFrom").fill("01/01/2026");
await page.locator("#openedTo").fill("01/07/2026");
await Promise.all([
  page.waitForURL(/CaseSearch/, { timeout: 120000 }),
  page.locator("#searchButton").click(),
]);
await page.waitForSelector("#gridSearchResults tbody tr", { timeout: 120000 });
await page.locator("#gridSearchResults_next").click().catch(() => null);
await page.waitForTimeout(2000);

if (capturedPost) {
  fs.writeFileSync(path.join(OUT, "_evict-datatables-post.txt"), capturedPost.body || "");
  console.log("POST body:", capturedPost.body?.slice(0, 2000));
}

await browser.close();

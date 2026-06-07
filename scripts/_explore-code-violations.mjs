import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const SEARCH_URL =
  "https://aca-prod.accela.com/MANSFIELD/Cap/CapHome.aspx?module=Building&TabName=Building";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("response", async (resp) => {
  const url = resp.url();
  if (/CapHome|CapDetail|CapList|Search|ajax/i.test(url) && resp.request().method() === "POST") {
    try {
      const text = await resp.text();
      if (text.length > 50 && text.length < 500000) {
        const safe = url.replace(/[^a-z0-9]+/gi, "-").slice(-80);
        fs.writeFileSync(path.join(OUT, `_code-post-${Date.now()}-${safe}.txt`), text.slice(0, 100000));
        console.log("POST", resp.status(), url.slice(0, 120));
      }
    } catch {
      // ignore
    }
  }
});

await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(2000);
fs.writeFileSync(path.join(OUT, "_code-accela-home.html"), await page.content());

const recordTypes = await page.locator("#ctl00_PlaceHolderMain_generalSearchForm_ddlGSPermitType option").evaluateAll((opts) =>
  opts.map((o) => ({ value: o.value, text: o.textContent?.trim() }))
);
console.log(
  "record types (code/compliance):",
  JSON.stringify(
    recordTypes.filter((o) => /code|compliance|violation|demolition|enforcement/i.test(o.text)),
    null,
    2
  )
);

const inputs = await page.locator("input, select, button, a").evaluateAll((els) =>
  els
    .map((el) => ({
      tag: el.tagName,
      type: el.type || null,
      id: el.id,
      name: el.name,
      value: el.value?.slice?.(0, 60) || el.value,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    }))
    .filter((e) => /date|search|record|permit|type|address|street|start|end/i.test(`${e.id} ${e.name} ${e.text}`))
);
console.log("relevant controls:", JSON.stringify(inputs.slice(0, 40), null, 2));

// Try selecting Residential Code Compliance
const codeType = recordTypes.find((o) => /Residential Code Compliance/i.test(o.text));
if (codeType) {
  await page.selectOption("#ctl00_PlaceHolderMain_generalSearchForm_ddlGSPermitType", codeType.value);
}
await page.locator("#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate").fill("01/01/2026");
await page.locator("#ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate").fill("01/31/2026");

await Promise.all([
  page.waitForNavigation({ waitUntil: "networkidle", timeout: 120000 }).catch(() => null),
  page.locator("#ctl00_PlaceHolderMain_btnNewSearch").click(),
]);
await page.waitForTimeout(3000);

const resultsHtml = await page.content();
fs.writeFileSync(path.join(OUT, "_code-accela-results.html"), resultsHtml);
console.log("results url:", page.url());
console.log("body snippet:", (await page.innerText("body")).slice(0, 4000));

const $ = cheerio.load(resultsHtml);
const tables = [];
$("table").each((i, table) => {
  const headers = $(table)
    .find("tr")
    .first()
    .find("th, td")
    .map((__, c) => $(c).text().replace(/\s+/g, " ").trim())
    .get();
  if (headers.some((h) => /record|address|status|date|type/i.test(h))) {
    const rows = [];
    $(table)
      .find("tr")
      .slice(1, 6)
      .each((__, tr) => {
        rows.push(
          $(tr)
            .find("td")
            .map((___, td) => $(td).text().replace(/\s+/g, " ").trim())
            .get()
        );
      });
    tables.push({ id: $(table).attr("id"), headers, rows });
  }
});
console.log("tables:", JSON.stringify(tables, null, 2));

const detailLink = await page.locator('a[href*="CapDetail"], a[href*="CapID"]').first().getAttribute("href").catch(() => null);
console.log("first detail link:", detailLink);

if (detailLink) {
  await page.goto(new URL(detailLink, page.url()).href, { waitUntil: "networkidle", timeout: 120000 });
  fs.writeFileSync(path.join(OUT, "_code-accela-detail.html"), await page.content());
  console.log("detail body:", (await page.innerText("body")).slice(0, 5000));
}

await browser.close();

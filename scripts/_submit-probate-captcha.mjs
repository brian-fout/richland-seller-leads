import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { openSearchForm, BASE_URL } from "./probate-session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");

function parseResults(html) {
  const $ = cheerio.load(html);
  const records = [];
  $("a[href*='recordDetail']").each((_, link) => {
    const href = $(link).attr("href");
    const caseNumber = $(link).text().replace(/\s+/g, " ").trim();
    if (!/\d/.test(caseNumber)) return;
    const cells = $(link)
      .closest("tr")
      .find("td")
      .map((__, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    records.push({ case_number: caseNumber, cells, detail_url: href ? new URL(href, BASE_URL).href : null });
  });
  return records;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await openSearchForm(page, page.context());

await page.evaluate(() => {
  for (const id of ["checkCaseType-PC", "checkCaseType-PG", "checkCaseType-PR", "checkCaseType-PM", "checkCaseType-PT"]) {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  }
  document.getElementById("checkCaseType-PE").checked = true;
});
await page.selectOption("#searchFMonth", "1");
await page.selectOption("#searchFDay", "15");
await page.selectOption("#searchFYear", "2026");
await page.locator("#optionBlock-100").check();

const imgPath = path.join(OUT, "_probate-live-captcha.png");
await page.locator("#captchaImage").screenshot({ path: imgPath });
console.error("Solve captcha in image:", imgPath);
console.error("Paste code as: node scripts/_submit-probate-captcha.mjs CODE");

// If code passed on CLI, submit in same session
const code = process.argv[2];
if (!code) {
  await browser.close();
  process.exit(0);
}

await page.locator("#captchaResponse").fill(code);
await Promise.all([
  page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
  page.locator("#buttonSubmit").click(),
]);
await page.waitForTimeout(1500);

const body = await page.innerText("body");
const html = await page.content();
fs.writeFileSync(path.join(OUT, "_probate-success.html"), html);

if (/CAPTCHA response was incorrect/i.test(body)) {
  console.error("CAPTCHA incorrect");
  process.exit(1);
}

const records = parseResults(html);
console.log("Records:", records.length);
console.log(JSON.stringify(records.slice(0, 5), null, 2));
console.error(body.slice(0, 1000));

await browser.close();

/**
 * Fill probate search, save CAPTCHA image, wait for code file, then submit.
 *
 * Usage:
 *   node scripts/probate-wait-captcha.mjs
 *   echo YourCode > data/probate-captcha-code.txt
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { openSearchForm, BASE_URL } from "./probate-session.mjs";
import { incrementalFromUsDate, parseUsDate, fmtUsDate } from "./scrape-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const CAPTCHA_IMAGE = path.join(DATA, "probate-captcha.png");
const CODE_FILE = path.join(DATA, "probate-captcha-code.txt");

function parseResults(html) {
  const $ = cheerio.load(html);
  const records = [];
  $("a[href*='recordDetail']").each((_, link) => {
    const caseNumber = $(link).text().replace(/\s+/g, " ").trim();
    if (!/\d/.test(caseNumber)) return;
    const cells = $(link)
      .closest("tr")
      .find("td")
      .map((__, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get();
    records.push({ case_number: caseNumber, cells });
  });
  return records;
}

function waitForCode(maxMs = 900000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(CODE_FILE)) {
        const code = fs.readFileSync(CODE_FILE, "utf8").trim();
        if (code) return resolve(code);
      }
      if (Date.now() - start > maxMs) return reject(new Error("Timed out waiting for captcha code"));
      setTimeout(tick, 500);
    };
    tick();
  });
}

const from = parseUsDate(incrementalFromUsDate("probate-estates"));
const month = from.getMonth() + 1;
const day = from.getDate();
const year = from.getFullYear();
const label = fmtUsDate(from);

fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(CODE_FILE)) fs.unlinkSync(CODE_FILE);

const headed = process.argv.includes("--headed");

const browser = await chromium.launch({
  headless: !headed,
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = await browser.newPage();
await openSearchForm(page, page.context());
await page.waitForSelector("#checkCaseType-PE", { state: "visible", timeout: 30000 });
for (const id of ["checkCaseType-PC", "checkCaseType-PG", "checkCaseType-PR", "checkCaseType-PM", "checkCaseType-PT"]) {
  await page.locator(`#${id}`).uncheck({ force: true });
}
await page.locator("#checkCaseType-PE").check({ force: true });
await page.selectOption("#searchFMonth", String(month));
await page.selectOption("#searchFDay", String(day));
await page.selectOption("#searchFYear", String(year));
await page.locator("#optionBlock-100").check({ force: true });
await page.locator("#captchaImage").screenshot({ path: CAPTCHA_IMAGE });

console.error(`Search period: ${label}`);
console.error(`CAPTCHA saved: ${CAPTCHA_IMAGE}`);
console.error(`Waiting for code in: ${CODE_FILE}`);
console.error("Write the code with: echo YourCode > data/probate-captcha-code.txt");

const code = await waitForCode();
console.error(`Submitting code: ${code}`);

await page.locator("#captchaResponse").fill(code);
await Promise.all([
  page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
  page.locator("#buttonSubmit").click(),
]);
await page.waitForTimeout(1500);

const body = await page.innerText("body");
const html = await page.content();
fs.writeFileSync(path.join(DATA, "_probate-submit-result.html"), html);

if (/CAPTCHA response was incorrect/i.test(body)) {
  console.error("CAPTCHA rejected");
  process.exit(1);
}

if (/You need to provide the entire file date/i.test(body)) {
  console.error("Validation error: entire file date required");
  process.exit(1);
}

if (/no cases were found|0 cases were found|no matching cases/i.test(body)) {
  console.log(JSON.stringify({ label, records: [], empty: true }, null, 2));
} else {
  const records = parseResults(html);
  console.log(JSON.stringify({ label, records, count: records.length }, null, 2));
}

fs.unlinkSync(CODE_FILE);
await browser.close();

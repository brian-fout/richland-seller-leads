import { chromium } from "playwright";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { solveCaptchaImage } from "./clerk-captcha.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://probatecourt.richlandcountyoh.gov";
const OUT = path.join(__dirname, "..", "data");

async function retry(fn, n = 4) {
  let err;
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw err;
}

async function acceptAgreement(page) {
  await retry(() =>
    page.goto(`${BASE}/recordSearch.php`, { waitUntil: "domcontentloaded", timeout: 90000 })
  );
  const cont = page.getByRole("link", { name: "Continue" });
  if (await cont.count()) {
    await Promise.all([
      page.waitForURL(/acceptAgreement|searchForm/i, { timeout: 30000 }).catch(() => null),
      cont.click(),
    ]);
  }
  await page.waitForSelector("#searchForm", { timeout: 30000 });
}

async function fillEstateSearch(page, month, day, year) {
  await page.evaluate(() => {
    for (const id of ["checkCaseType-PC", "checkCaseType-PG", "checkCaseType-PR", "checkCaseType-PM", "checkCaseType-PT"]) {
      const el = document.getElementById(id);
      if (el) el.checked = false;
    }
    document.getElementById("checkCaseType-PE").checked = true;
  });
  await page.selectOption("#searchFMonth", String(month));
  await page.selectOption("#searchFDay", String(day));
  await page.selectOption("#searchFYear", String(year));
  await page.locator("#optionBlock-100").check();
}

function parseResults(html) {
  const $ = cheerio.load(html);
  const records = [];

  $("table").each((_, table) => {
    const headers = [];
    $(table)
      .find("tr")
      .first()
      .find("th, td")
      .each((__, cell) => headers.push($(cell).text().replace(/\s+/g, " ").trim().toLowerCase()));

    if (!headers.some((h) => h.includes("case") || h.includes("name"))) return;

    $(table)
      .find("tr")
      .slice(1)
      .each((__, row) => {
        const cells = $(row)
          .find("td")
          .map((___, td) => $(td).text().replace(/\s+/g, " ").trim())
          .get();
        if (cells.length < 2) return;

        const link = $(row).find("a[href*='recordDetail']").first();
        const href = link.attr("href");
        const caseNumber = link.text().trim() || cells[0];
        if (!/\d/.test(caseNumber)) return;

        const rowObj = {};
        headers.forEach((h, i) => {
          if (cells[i]) rowObj[h] = cells[i];
        });

        records.push({
          case_number: caseNumber,
          decedent_name: rowObj.name ?? rowObj.party ?? cells[1] ?? null,
          file_date: rowObj["file date"] ?? rowObj["filing date"] ?? cells.find((c) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(c)) ?? null,
          case_type: rowObj.type ?? "Estate",
          status: rowObj.status ?? null,
          detail_url: href ? new URL(href, BASE).href : null,
        });
      });
  });

  return records;
}

async function searchEstateByDate(page, month, day, year, maxAttempts = 20) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await fillEstateSearch(page, month, day, year);
    if (attempt > 1) {
      await page.evaluate(() => captchaRefresh());
      await page.waitForTimeout(800);
    }

    const code = await solveCaptchaImage(await page.locator("#captchaImage").screenshot());
    console.error(`  ${month}/${day}/${year} captcha ${attempt}: "${code}"`);
    if (code.length < 4) continue;

    await page.locator("#captchaResponse").fill(code);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
      page.locator("#buttonSubmit").click(),
    ]);
    await page.waitForTimeout(1500);

    const body = await page.innerText("body");
    if (/CAPTCHA response was incorrect/i.test(body)) {
      await acceptAgreement(page).catch(() => {});
      continue;
    }

    const html = await page.content();
    if (/no cases were found|0 cases were found|no matches/i.test(body)) {
      return [];
    }

    const records = parseResults(html);
    if (records.length || /Search Results|cases were found/i.test(body)) {
      return records;
    }
  }

  throw new Error(`CAPTCHA failed for ${month}/${day}/${year}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await acceptAgreement(page);

const records = await searchEstateByDate(page, 1, 15, 2026);
console.log("Records:", records.length);
console.log(JSON.stringify(records.slice(0, 5), null, 2));
fs.writeFileSync(path.join(OUT, "_probate-results.html"), await page.content());

await browser.close();

import { chromium } from "playwright";
import { openSearchForm } from "./probate-session.mjs";
import { solveProbateCaptcha } from "./probate-captcha.mjs";

async function trySearch(page, context, label, month, day, year) {
  await openSearchForm(page, context);
  await page.evaluate(() => {
    for (const id of ["checkCaseType-PC", "checkCaseType-PG", "checkCaseType-PR", "checkCaseType-PM", "checkCaseType-PT"]) {
      const el = document.getElementById(id);
      if (el) el.checked = false;
    }
    document.getElementById("checkCaseType-PE").checked = true;
  });
  if (month) await page.selectOption("#searchFMonth", String(month));
  if (day) await page.selectOption("#searchFDay", String(day));
  if (year) await page.selectOption("#searchFYear", String(year));
  await page.locator("#optionBlock-100").check();

  for (let attempt = 1; attempt <= 8; attempt++) {
    const code = await solveProbateCaptcha(page, { attempt });
    await page.locator("#captchaResponse").fill(code);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
      page.locator("#buttonSubmit").click(),
    ]);
    await page.waitForTimeout(1200);
    const body = await page.innerText("body");
    if (/CAPTCHA response was incorrect/i.test(body)) continue;
    console.log(`\n=== ${label} attempt ${attempt} code ${code} ===`);
    console.log(body.slice(0, 1200));
    return;
  }
  console.log(`${label}: captcha failed`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const context = page.context();

await trySearch(page, context, "month-only Jan 2026", 1, null, 2026);
await trySearch(page, context, "day Jan 2 2026", 1, 2, 2026);

await browser.close();

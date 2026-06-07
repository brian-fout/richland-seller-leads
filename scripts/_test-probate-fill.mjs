import { chromium } from "playwright";
import { openSearchForm } from "./probate-session.mjs";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await openSearchForm(page, page.context());

for (const id of ["checkCaseType-PC", "checkCaseType-PG", "checkCaseType-PR", "checkCaseType-PM", "checkCaseType-PT"]) {
  await page.locator(`#${id}`).uncheck({ force: true });
}
await page.locator("#checkCaseType-PE").check({ force: true });
await page.selectOption("#searchFMonth", "1");
await page.selectOption("#searchFDay", "1");
await page.selectOption("#searchFYear", "2026");
await page.locator("#optionBlock-100").check({ force: true });

const state = await page.evaluate(() => ({
  PC: document.getElementById("checkCaseType-PC")?.checked,
  PE: document.getElementById("checkCaseType-PE")?.checked,
  block25: document.getElementById("optionBlock-25")?.checked,
  block100: document.getElementById("optionBlock-100")?.checked,
  month: document.getElementById("searchFMonth")?.value,
  day: document.getElementById("searchFDay")?.value,
  year: document.getElementById("searchFYear")?.value,
  hasRecordDetailInHtml: /recordDetail/.test(document.body.innerHTML),
  messageContainer: document.querySelector("#searchSection-submit .messageContainer")?.innerText,
}));

console.log(JSON.stringify(state, null, 2));
await browser.close();

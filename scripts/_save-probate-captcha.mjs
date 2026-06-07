import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { chromium } from "playwright";
import { openSearchForm } from "./probate-session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const imgPath = path.join(OUT, "_probate-live-captcha.png");

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
await page.locator("#captchaImage").screenshot({ path: imgPath });
await browser.close();

console.log("Saved", imgPath);

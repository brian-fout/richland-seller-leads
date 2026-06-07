import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { chromium } from "playwright";
import { openSearchForm } from "./probate-session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function ocrProbate(buffer) {
  const prepped = await sharp(buffer).resize({ width: 900 }).png().toBuffer();
  const {
    data: { text },
  } = await Tesseract.recognize(prepped, "eng", {
    tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  });
  return text.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
}

function variants(code) {
  const subs = [
    ["I", "1"],
    ["l", "1"],
    ["O", "0"],
    ["o", "0"],
    ["S", "5"],
    ["B", "8"],
    ["Z", "2"],
    ["I", "3"],
    ["i", "3"],
  ];
  const out = new Set([code, code.toLowerCase(), code.toUpperCase()]);
  for (const [from, to] of subs) {
    out.add(code.replaceAll(from, to));
    out.add(code.toLowerCase().replaceAll(from.toLowerCase(), to));
  }
  return [...out].filter((c) => c.length >= 4);
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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const context = page.context();
await openSearchForm(page, context);

for (let round = 1; round <= 10; round++) {
  await fillEstateSearch(page, 1, 15, 2026);
  const buf = await page.locator("#captchaImage").screenshot();
  const ocr = await ocrProbate(buf);
  console.error(`Round ${round} OCR: "${ocr}"`);

  for (const code of variants(ocr)) {
    await page.locator("#captchaResponse").fill(code);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
      page.locator("#buttonSubmit").click(),
    ]);
    await page.waitForTimeout(1200);
    const body = await page.innerText("body");
    if (/CAPTCHA response was incorrect/i.test(body)) {
      await openSearchForm(page, context);
      continue;
    }
    console.log("SUCCESS with code:", code);
    console.log(body.slice(0, 800));
    fs.writeFileSync(path.join(__dirname, "..", "data", "_probate-success.html"), await page.content());
    await browser.close();
    process.exit(0);
  }

  await openSearchForm(page, context);
  await page.evaluate(() => captchaRefresh());
  await page.waitForTimeout(800);
}

await browser.close();
throw new Error("All rounds failed");

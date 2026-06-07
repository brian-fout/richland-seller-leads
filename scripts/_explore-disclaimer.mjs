import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://countyfusion13.kofiletech.us/countyweb";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${BASE}/loginDisplay.action?countyname=RichlandOH`, { waitUntil: "networkidle" });
await page.locator('input[value*="Guest" i]').first().click();
await page.waitForTimeout(2000);

const frame = page.frame({ name: "bodyframe" });
console.log("Disclaimer HTML snippet:");
const html = await frame.content();
fs.writeFileSync(path.join(__dirname, "..", "data", "_recorder-disclaimer.html"), html);
console.log(html.slice(html.indexOf("Accept") - 200, html.indexOf("Accept") + 500));

// Try visible accept controls
for (const sel of [
  'input[type="submit"]',
  'input[type="button"]',
  'button',
  'a',
  'img[alt*="Accept" i]',
  '[onclick*="Accept" i]',
]) {
  const items = await frame.locator(sel).all();
  for (const item of items) {
    const info = await item.evaluate((el) => ({
      tag: el.tagName,
      type: el.getAttribute("type"),
      value: el.getAttribute("value"),
      text: el.textContent?.trim(),
      alt: el.getAttribute("alt"),
      onclick: el.getAttribute("onclick"),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }));
    if (/accept|agree|proceed|enter/i.test(JSON.stringify(info))) console.log(info);
  }
}

await browser.close();

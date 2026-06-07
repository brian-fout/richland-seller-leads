import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { solveCaptchaImage } from "./clerk-captcha.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://eservices.richlandcountycpcourt.org/eservices";
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

async function passCaptcha(page, attempts = 15) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await page.locator("a.captchaLink").click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    const buf = await page.locator("img.captchaImg").screenshot();
    const code = await solveCaptchaImage(buf);
    console.error(`Captcha attempt ${i + 1}: "${code}"`);
    if (code.length < 4) {
      continue;
    }

    await page.locator('input[name="captchaPanel:challengePassword"]').fill(code);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => null),
      page.locator("#id21").click(),
    ]);
    await page.waitForTimeout(2000);

    const body = await page.innerText("body");
    const stillCaptcha = /please enter letters from image/i.test(body);
    const failed = /incorrect|invalid|try again|does not match/i.test(body);
    if (!stillCaptcha && !failed) return true;
    console.error("  rejected");
  }
  return false;
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await retry(() => page.goto(`${BASE}/home.page`, { waitUntil: "networkidle", timeout: 90000 }));
if (!(await passCaptcha(page))) {
  console.error("Failed CAPTCHA");
  await browser.close();
  process.exit(1);
}

console.log("URL:", page.url());
console.log("Title:", await page.title());
console.log((await page.innerText("body")).slice(0, 4000));
fs.writeFileSync(path.join(OUT, "_clerk-after-captcha.html"), await page.content());

// Click Search nav if present
for (const sel of ['a:has-text("Search")', 'text=Search', '[href*="search"]']) {
  const loc = page.locator(sel).first();
  if (await loc.count()) {
    try {
      await loc.click();
      await page.waitForTimeout(3000);
      console.log("\nAfter Search click:", page.url());
      console.log((await page.innerText("body")).slice(0, 3000));
      fs.writeFileSync(path.join(OUT, "_clerk-search-page.html"), await page.content());
      break;
    } catch {}
  }
}

const selects = await page.$$eval("select", (els) =>
  els.map((s) => ({ name: s.name, id: s.id, options: [...s.options].slice(0, 20).map((o) => o.text.trim()) }))
);
console.log("\nSelects:", JSON.stringify(selects, null, 2));

await browser.close();

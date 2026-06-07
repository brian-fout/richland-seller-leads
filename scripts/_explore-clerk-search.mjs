import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await retry(() => page.goto(`${BASE}/home.page`, { waitUntil: "networkidle", timeout: 90000 }));
fs.writeFileSync(path.join(OUT, "_clerk-home.html"), await page.content());

const inputs = await page.$$eval("input", (els) =>
  els.map((i) => ({ type: i.type, name: i.name, id: i.id }))
);
console.log("Inputs:", inputs);

const imgs = await page.$$eval("img", (els) =>
  els.map((i) => ({ src: i.src, id: i.id, alt: i.alt }))
);
console.log("Imgs:", imgs.filter((i) => /captcha|image|verify/i.test(JSON.stringify(i))));

// Find form around captcha
const html = await page.content();
const captchaMatch = html.match(/captcha[^"']{0,80}/gi);
console.log("Captcha refs:", captchaMatch?.slice(0, 10));

// Click Here link href
const clickHref = await page.locator('a:has-text("Click Here")').first().getAttribute("href");
console.log("Click Here href:", clickHref);

// Try home.page.2
await retry(() => page.goto(`${BASE}/home.page.2`, { waitUntil: "networkidle", timeout: 60000 }));
console.log("\nhome.page.2 title:", await page.title());
console.log((await page.innerText("body")).slice(0, 2000));
fs.writeFileSync(path.join(OUT, "_clerk-home2.html"), await page.content());

const links = await page.$$eval("a", (els) =>
  els.map((a) => ({ href: a.href, text: (a.textContent || "").replace(/\s+/g, " ").trim() })).filter((l) => /search|case|calendar|civil/i.test(l.text + l.href))
);
console.log("\nSearch-related links:", links);

await browser.close();

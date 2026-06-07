import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://probatecourt.richlandcountyoh.gov";
const OUT = path.join(__dirname, "..", "data");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(`${BASE}/recordSearch.php`, { waitUntil: "networkidle", timeout: 90000 });
console.log("Title:", await page.title());
console.log((await page.innerText("body")).slice(0, 1500));

// Accept disclaimer
const cont = page.locator('input[value="Continue"], button:has-text("Continue"), a:has-text("Continue")');
if (await cont.count()) {
  await cont.first().click();
  await page.waitForTimeout(3000);
}

console.log("\nAfter continue:", page.url());
console.log((await page.innerText("body")).slice(0, 3000));
fs.writeFileSync(path.join(OUT, "_probate-search.html"), await page.content());

const links = await page.$$eval("a", (els) =>
  els.map((a) => ({ href: a.href, text: (a.textContent || "").replace(/\s+/g, " ").trim() })).filter((l) => l.text)
);
console.log("\nLinks:", links.slice(0, 30));

const selects = await page.$$eval("select", (els) =>
  els.map((s) => ({
    name: s.name,
    id: s.id,
    options: [...s.options].map((o) => ({ value: o.value, text: o.text.trim() })),
  }))
);
console.log("\nSelects:", JSON.stringify(selects, null, 2).slice(0, 4000));

const inputs = await page.$$eval("input", (els) =>
  els.map((i) => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder }))
);
console.log("\nInputs:", inputs);

await browser.close();

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://eservices.richlandcountycpcourt.org/eservices";
const OUT = path.join(__dirname, "..", "data");

const cookies = JSON.parse(fs.readFileSync(path.join(OUT, "clerk-cookies.json"), "utf8"));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addCookies(cookies);
const page = await ctx.newPage();
await page.goto(`${BASE}/search.page`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(2000);

console.log("URL:", page.url());
console.log("Body snippet:", (await page.innerText("body")).slice(0, 1500));

const tabs = await page.$$eval("a, button, input[type=button], input[type=submit], h2, h3, span", (els) =>
  els
    .map((e) => ({
      tag: e.tagName,
      text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      id: e.id,
      href: e.href || null,
      value: e.value || null,
      cls: e.className?.slice?.(0, 60) || null,
    }))
    .filter((x) => /filing|case number|search|date|civil|party/i.test(x.text + (x.value || "")))
);
console.log("Search UI elements:", JSON.stringify(tabs, null, 2));

const inputs = await page.$$eval("input, select", (els) =>
  els.map((e) => ({
    tag: e.tagName,
    type: e.type,
    name: e.name,
    id: e.id,
    visible: !!(e.offsetWidth || e.offsetHeight),
    value: e.value,
    options:
      e.tagName === "SELECT"
        ? [...e.options].slice(0, 8).map((o) => o.text.trim())
        : undefined,
  }))
);
console.log("Form fields:", JSON.stringify(inputs, null, 2));

// Try clicking Filing Date tab
for (const sel of ['a:has-text("Filing Date")', 'text=Filing Date', 'input[value*="Filing Date"]']) {
  const loc = page.locator(sel).first();
  if (await loc.count()) {
    console.log("\nClicking:", sel);
    await loc.click().catch((e) => console.log("click failed", e.message));
    await page.waitForTimeout(1500);
    break;
  }
}

const inputsAfter = await page.$$eval("input, select", (els) =>
  els
    .filter((e) => !!(e.offsetWidth || e.offsetHeight))
    .map((e) => ({
      tag: e.tagName,
      type: e.type,
      name: e.name,
      id: e.id,
      value: e.value,
      parentText: e.closest("tr, fieldset, div.formSec2, div.inputSection")?.innerText?.slice(0, 120),
    }))
);
console.log("\nVisible fields after Filing Date click:", JSON.stringify(inputsAfter, null, 2));

fs.writeFileSync(path.join(OUT, "_clerk-search-form.html"), await page.content());
await browser.close();

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

const tabs = await page.$$eval("#searchPageTabSection a", (els) =>
  els.map((e) => ({ text: e.innerText.replace(/\s+/g, " ").trim(), id: e.id }))
);
console.log("Tabs:", tabs);

for (const tab of tabs) {
  console.log(`\n=== Clicking tab: ${tab.text} ===`);
  await page.locator(`#${tab.id}`).click();
  await page.waitForTimeout(2000);

  const fields = await page.$$eval("input, select", (els) =>
    els
      .filter((e) => !!(e.offsetWidth || e.offsetHeight))
      .map((e) => ({
        tag: e.tagName,
        type: e.type,
        name: e.name,
        id: e.id,
        label: document.querySelector(`label[for="${e.id}"]`)?.textContent?.trim(),
        options:
          e.tagName === "SELECT"
            ? [...e.options].map((o) => o.text.trim()).filter(Boolean)
            : undefined,
        section: e.closest(".formSec2, .inputSection, fieldset, table")?.innerText?.slice(0, 200),
      }))
  );
  console.log(JSON.stringify(fields, null, 2));
}

await browser.close();

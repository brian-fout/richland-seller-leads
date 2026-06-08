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

await page.locator('a:has-text("Case Type")').click();
await page.waitForTimeout(2500);

const fields = await page.evaluate(() =>
  [...document.querySelectorAll("input, select")]
    .filter((e) => e.offsetWidth || e.offsetHeight)
    .map((e) => ({
      tag: e.tagName,
      type: e.type,
      name: e.name,
      id: e.id,
      label: document.querySelector(`label[for="${e.id}"]`)?.textContent?.trim(),
      options:
        e.tagName === "SELECT" ? [...e.options].map((o) => ({ text: o.text.trim(), value: o.value })) : undefined,
      section: e.closest(".formElement, tr, fieldset, .formElements")?.innerText?.slice(0, 400),
    }))
);

console.log(JSON.stringify(fields, null, 2));
console.log("\nBody:", (await page.innerText("body")).slice(0, 3000));

fs.writeFileSync(path.join(OUT, "_clerk-case-type-tab.html"), await page.content());
await browser.close();

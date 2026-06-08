import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  openSearchArea,
  submitCaseTypeSearch,
  collectAllSearchResults,
  countResultsHint,
  isForeclosureRecord,
} from "./clerk-search.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://eservices.richlandcountycpcourt.org/eservices";
const OUT = path.join(__dirname, "..", "data");

const cookies = JSON.parse(fs.readFileSync(path.join(OUT, "clerk-cookies.json"), "utf8"));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addCookies(cookies);
const page = await ctx.newPage();

await openSearchArea(page, BASE);
await submitCaseTypeSearch(page, "01/01/2026", "01/31/2026");

const body = await page.innerText("body");
const html = await page.content();
fs.writeFileSync(path.join(OUT, "_clerk-case-type-results.html"), html);

const expected = countResultsHint(body, html);
const all = await collectAllSearchResults(page);
const foreclosures = all.filter(isForeclosureRecord);

console.log("Expected hint:", expected);
console.log("All civil cases:", all.length);
console.log("Foreclosures:", foreclosures.length);
console.log("Sample foreclosure:", foreclosures[0]);

await browser.close();

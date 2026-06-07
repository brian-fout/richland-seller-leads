import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const SEARCH_URL =
  "https://beacon.schneidercorp.com/Application.aspx?AppID=1067&LayerID=25465&PageTypeID=2&PageID=10347";
const SAMPLE_PARCEL = "027-06-078-13-001";

const headless = !process.argv.includes("--headed");

const browser = await chromium.launch({
  headless,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

console.log(`mode: ${headless ? "headless" : "headed"}`);
await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForTimeout(5000);

const title = await page.title();
const body = await page.innerText("body");
console.log("title:", title);
console.log("body:", body.slice(0, 500));
fs.writeFileSync(path.join(OUT, `_auditor-${headless ? "headless" : "headed"}-landing.html`), await page.content());

if (/Just a moment|security verification|turnstile/i.test(body)) {
  console.log("BLOCKED: Cloudflare challenge detected");
  if (headless) {
    console.log("Retry with --headed to test if manual browser passes challenge");
  } else {
    console.log("Waiting 30s for challenge to resolve in headed mode...");
    await page.waitForTimeout(30000);
    const body2 = await page.innerText("body");
    console.log("after wait title:", await page.title());
    console.log("after wait body:", body2.slice(0, 500));
    fs.writeFileSync(path.join(OUT, "_auditor-headed-after-wait.html"), await page.content());
  }
} else {
  console.log("PASSED: No Cloudflare block on landing");
}

await browser.close();

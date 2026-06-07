import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://countyfusion13.kofiletech.us/countyweb";
const RECORDER_LOGIN = `${BASE}/loginDisplay.action?countyname=RichlandOH`;

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

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const page = await context.newPage();
const requests = [];
page.on("response", async (resp) => {
  const url = resp.url();
  if (/search|document|result|lis|pendens|do\?|\.action/i.test(url)) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 300);
    } catch {}
    requests.push({ status: resp.status(), url, body });
  }
});

await retry(() => page.goto(RECORDER_LOGIN, { waitUntil: "networkidle", timeout: 90000 }));
await page.locator('input[value*="Guest" i]').first().click();
await page.waitForTimeout(3000);

const frame = page.frame({ name: "bodyframe" });
if (frame) {
  console.log("Frame URL:", frame.url());
  console.log("Frame text:", (await frame.innerText("body")).slice(0, 2000));

  // Accept disclaimer if present
  for (const sel of ['input[value*="Accept" i]', 'button:has-text("Accept")', 'input[value*="I Agree" i]', 'a:has-text("Accept")']) {
    const loc = frame.locator(sel).first();
    if (await loc.count()) {
      console.log("Clicking", sel);
      await loc.click();
      await page.waitForTimeout(3000);
      break;
    }
  }

  console.log("\nAfter disclaimer:", frame.url());
  console.log((await frame.innerText("body")).slice(0, 3000));

  const links = await frame.$$eval("a", (els) =>
    els.map((a) => ({ href: a.href, text: (a.textContent || "").replace(/\s+/g, " ").trim() })).filter((l) => l.text)
  );
  console.log("\nFrame links:", links.slice(0, 50));
  fs.writeFileSync(path.join(__dirname, "..", "data", "_recorder-frame.html"), await frame.content());
}

// Also check top menu links
const menuLinks = await page.$$eval("a", (els) =>
  els.map((a) => ({ href: a.href, text: (a.textContent || "").replace(/\s+/g, " ").trim() })).filter((l) => l.text)
);
console.log("\nTop menu links:", menuLinks);

fs.writeFileSync(path.join(__dirname, "..", "data", "_recorder-requests.json"), JSON.stringify(requests, null, 2));
await browser.close();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { openSearchForm } from "./probate-session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const audioUrls = [];
page.on("response", async (resp) => {
  const url = resp.url();
  if (/captcha.*audio|m=audio/i.test(url)) {
    audioUrls.push({ url, status: resp.status(), type: resp.headers()["content-type"] });
    try {
      const buf = await resp.body();
      fs.writeFileSync(path.join(OUT, "_probate-captcha-audio.wav"), buf);
    } catch {}
  }
});

await openSearchForm(page, context);
await page.evaluate(() => captchaPlay());
await page.waitForTimeout(3000);

console.log(JSON.stringify(audioUrls, null, 2));
console.log("body snippet:", (await page.innerText("body")).slice(0, 500));

await browser.close();

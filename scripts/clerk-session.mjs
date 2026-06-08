/**
 * @county richland — Clerk of Courts session helpers (CAPTCHA gate + cookie reuse).
 */

import fs from "fs";
import path from "path";
import { dataRoot } from "../src/core/county-context.mjs";
import { solveCaptchaImage } from "./clerk-captcha.mjs";

export const DATA_DIR = dataRoot();
export const COOKIE_PATH = path.join(DATA_DIR, "clerk-cookies.json");
export const BASE_URL = "https://eservices.richlandcountycpcourt.org/eservices";

export async function retry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

export async function saveCookies(context) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(await context.cookies(), null, 2));
}

export async function loadCookies(context) {
  if (!fs.existsSync(COOKIE_PATH)) return false;
  const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf8"));
  await context.addCookies(cookies);
  return true;
}

export function captchaVisibleText(bodyText) {
  return /please enter letters from image/i.test(bodyText);
}

export async function waitForInteractiveCaptcha(page, timeoutMs = 600000) {
  console.error('>>> Enter CAPTCHA in the browser and click "Click Here To search public records".');
  console.error(`    (Waiting up to ${Math.round(timeoutMs / 60000)} minutes…)\n`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await page.innerText("body").catch(() => "");
    if (!captchaVisibleText(body) && /search|calendar|welcome page|case/i.test(body)) {
      await saveCookies(page.context());
      console.error("  CAPTCHA accepted — continuing…");
      return true;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for manual CAPTCHA");
}

export async function tryOcrCaptcha(page, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await page.locator("a.captchaLink").click().catch(() => {});
      await page.waitForTimeout(1200);
    }

    const code = await solveCaptchaImage(await page.locator("img.captchaImg").screenshot());
    if (code.length < 4) continue;

    await page.locator('input[name="captchaPanel:challengePassword"]').fill(code);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => null),
      page.locator("#id21").click(),
    ]);
    await page.waitForTimeout(1500);

    if (!captchaVisibleText(await page.innerText("body"))) {
      await saveCookies(page.context());
      return true;
    }
  }
  return false;
}

export async function ensureClerkSession(page, context, { ocrAttempts = 8, interactive = false } = {}) {
  await loadCookies(context);

  await retry(() => page.goto(`${BASE_URL}/search.page`, { waitUntil: "domcontentloaded", timeout: 90000 }));
  let body = await page.innerText("body");

  if (!captchaVisibleText(body) && /search|case|filing|calendar/i.test(body)) {
    await saveCookies(context);
    return page.url();
  }

  await retry(() => page.goto(`${BASE_URL}/home.page`, { waitUntil: "domcontentloaded", timeout: 90000 }));
  body = await page.innerText("body");

  if (!captchaVisibleText(body)) {
    await saveCookies(context);
    return page.url();
  }

  const captchaArg = process.argv.find((a) => a.startsWith("--captcha="))?.split("=")[1];
  if (captchaArg) {
    await page.locator('input[name="captchaPanel:challengePassword"]').fill(captchaArg);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null),
      page.locator("#id21").click(),
    ]);
    await page.waitForTimeout(1500);
    if (!captchaVisibleText(await page.innerText("body"))) {
      await saveCookies(context);
      return page.url();
    }
    throw new Error("CAPTCHA value from --captcha= was rejected");
  }

  if (interactive) {
    await waitForInteractiveCaptcha(page);
    return page.url();
  }

  if (ocrAttempts > 0 && (await tryOcrCaptcha(page, ocrAttempts))) {
    return page.url();
  }

  throw new Error(
    "Clerk session unavailable. Run: npm run scrape:clerk:session (solve CAPTCHA once), npm run scrape:clerk-foreclosures -- --interactive, npm run enrich:clerk-foreclosures -- --no-details, or pass --captcha=xxxx"
  );
}

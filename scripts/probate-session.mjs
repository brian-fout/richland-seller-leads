/**
 * Accept CaseLook disclaimer and optionally reuse cookies.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "..", "data");
export const COOKIE_PATH = path.join(DATA_DIR, "probate-cookies.json");
export const BASE_URL = "https://probatecourt.richlandcountyoh.gov";

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
  await context.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, "utf8")));
  return true;
}

export async function openSearchForm(page, context) {
  await loadCookies(context);
  await retry(() =>
    page.goto(`${BASE_URL}/recordSearch.php`, { waitUntil: "domcontentloaded", timeout: 90000 })
  );

  if (await page.locator("#searchForm").count()) {
    await saveCookies(context);
    return;
  }

  const cont = page.getByRole("link", { name: "Continue" });
  if (await cont.count()) {
    await Promise.all([
      page.waitForURL(/acceptAgreement|searchForm/i, { timeout: 30000 }).catch(() => null),
      cont.click(),
    ]);
  }

  await page.waitForSelector("#searchForm", { timeout: 30000 });
  await saveCookies(context);
}

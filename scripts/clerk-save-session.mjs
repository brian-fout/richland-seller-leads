/**
 * Save Clerk of Courts session cookies after manual CAPTCHA solve.
 *
 * Usage: node scripts/clerk-save-session.mjs
 *
 * A browser window opens — enter the CAPTCHA letters and click
 * "Click Here To search public records." Cookies are saved when the
 * welcome CAPTCHA screen disappears.
 */

import { chromium } from "playwright";
import { COOKIE_PATH, saveCookies, BASE_URL, waitForInteractiveCaptcha } from "./clerk-session.mjs";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.error("Opening Richland Clerk of Courts eAccess...");
console.error("1. Enter the CAPTCHA letters");
console.error('2. Click "Click Here To search public records"');
console.error("3. Waiting up to 10 minutes...\n");

page.setDefaultTimeout(600000);
await page.goto(`${BASE_URL}/home.page`, { waitUntil: "domcontentloaded", timeout: 90000 });

await waitForInteractiveCaptcha(page);
await page.waitForTimeout(2000);
await saveCookies(context);

console.error(`\nSession saved to ${COOKIE_PATH}`);
console.error("Current URL:", page.url());
console.error("You can close the browser window.");

await browser.close();

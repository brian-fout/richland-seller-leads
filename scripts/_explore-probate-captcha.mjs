import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { openSearchForm, BASE_URL } from "./probate-session.mjs";
import { solveCaptchaImage } from "./clerk-captcha.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

await openSearchForm(page, context);

const imgBuf = await page.locator("#captchaImage").screenshot();
fs.writeFileSync(path.join(OUT, "_probate-captcha.png"), imgBuf);

const audioUrl = `${BASE_URL}/captcha/showCaptcha.php?m=audio&t=${Date.now()}`;
const audioResp = await page.request.get(audioUrl);
const audioBuf = await audioResp.body();
fs.writeFileSync(path.join(OUT, "_probate-captcha.wav"), audioBuf);

console.error("Image bytes:", imgBuf.length, "Audio bytes:", audioBuf.length, "Audio type:", audioResp.headers()["content-type"]);

const ocr = await solveCaptchaImage(imgBuf);
console.log("OCR:", ocr);

await browser.close();

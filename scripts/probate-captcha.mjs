import sharp from "sharp";
import Tesseract from "tesseract.js";

const CONFUSIONS = [
  ["I", "1"],
  ["l", "1"],
  ["O", "0"],
  ["o", "0"],
  ["S", "5"],
  ["s", "5"],
  ["B", "8"],
  ["Z", "2"],
  ["z", "2"],
  ["I", "3"],
  ["i", "3"],
  ["G", "6"],
  ["g", "6"],
];

export async function ocrProbateCaptcha(buffer) {
  const prepped = await sharp(buffer).resize({ width: 900 }).png().toBuffer();
  const {
    data: { text },
  } = await Tesseract.recognize(prepped, "eng", {
    tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  });
  return text.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
}

export function captchaVariants(code) {
  const seeds = new Set([code, code.toLowerCase(), code.toUpperCase()]);
  for (const seed of [...seeds]) {
    for (const [from, to] of CONFUSIONS) {
      seeds.add(seed.replaceAll(from, to));
      seeds.add(seed.replaceAll(from.toLowerCase(), to));
    }
  }
  return [...seeds].filter((c) => c.length >= 4);
}

/**
 * Try OCR + common character confusions. Returns next candidate code to submit.
 */
export async function solveProbateCaptcha(page, { attempt = 1 } = {}) {
  if (attempt > 1) {
    await page.evaluate(() => captchaRefresh());
    await page.waitForTimeout(800);
  }
  const buf = await page.locator("#captchaImage").screenshot();
  const ocr = await ocrProbateCaptcha(buf);
  const variants = captchaVariants(ocr);
  return variants[(attempt - 1) % variants.length] ?? ocr;
}

export async function solveCaptchaImage(buffer) {
  return ocrProbateCaptcha(buffer);
}

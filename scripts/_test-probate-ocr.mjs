import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import Tesseract from "tesseract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imgPath = path.join(__dirname, "..", "data", "_probate-captcha.png");
const buf = fs.readFileSync(imgPath);

async function recognize(buffer, opts = {}) {
  const {
    data: { text },
  } = await Tesseract.recognize(buffer, "eng", {
    tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: opts.psm ?? Tesseract.PSM.SINGLE_LINE,
  });
  return text.replace(/[^a-zA-Z0-9]/g, "");
}

async function preprocess(buffer, variant) {
  let img = sharp(buffer);
  switch (variant) {
    case "scale6-thresh":
      return img.grayscale().resize({ width: 900, kernel: sharp.kernel.nearest }).threshold(140).png().toBuffer();
    case "scale6-soft":
      return img.grayscale().normalize().resize({ width: 900 }).png().toBuffer();
    case "scale6-median":
      return img.grayscale().resize({ width: 900 }).median(3).threshold(150).png().toBuffer();
    case "scale6-negate":
      return img.grayscale().negate().normalize().resize({ width: 900 }).threshold(145).png().toBuffer();
    case "raw-large":
      return img.resize({ width: 900 }).png().toBuffer();
    default:
      return img.grayscale().resize({ width: 600 }).png().toBuffer();
  }
}

const variants = ["scale6-thresh", "scale6-soft", "scale6-median", "scale6-negate", "raw-large", "default"];
for (const variant of variants) {
  const prepped = await preprocess(buf, variant);
  for (const psm of [7, 8, 13]) {
    const text = await recognize(prepped, { psm });
    console.log(`${variant} psm=${psm}: "${text}"`);
  }
}

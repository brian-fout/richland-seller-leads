import sharp from "sharp";
import Tesseract from "tesseract.js";

async function recognize(buffer) {
  const {
    data: { text },
  } = await Tesseract.recognize(buffer, "eng", {
    tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyz0123456789",
  });
  return text.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

async function preprocess(buffer, variant) {
  let img = sharp(buffer);
  switch (variant) {
    case "large-thresh":
      return img.grayscale().resize({ width: 600, kernel: sharp.kernel.nearest }).threshold(145).png().toBuffer();
    case "large-soft":
      return img.grayscale().normalize().resize({ width: 600 }).png().toBuffer();
    case "negate":
      return img.grayscale().negate().normalize().resize({ width: 600 }).threshold(150).png().toBuffer();
    default:
      return img.grayscale().resize({ width: 500 }).png().toBuffer();
  }
}

export async function solveCaptchaImage(buffer) {
  const variants = ["large-thresh", "large-soft", "negate", "default"];
  let best = "";

  for (const variant of variants) {
    const prepped = await preprocess(buffer, variant);
    const text = await recognize(prepped);
    if (text.length === 4) return text;
    if (text.length > best.length) best = text.slice(0, 4);
  }

  return best;
}

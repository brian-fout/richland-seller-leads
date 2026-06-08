/**
 * @county richland — Download auditor CAMA Update .DAT files from Google Drive.
 *
 * Usage: npm run download:auditor-cama
 *   node scripts/download-auditor-cama.mjs --files SALES.DAT,MAILDATMAX.DAT
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { CAMA_DIR } from "./auditor-cama-dat.mjs";
import { RICHLAND_COUNTY } from "../src/counties/richland/config.mjs";

export { CAMA_DIR };
export const DRIVE_MAP_PATH = path.join(CAMA_DIR, "drive-file-map.json");
export const CAMA_FOLDER = RICHLAND_COUNTY.auditor.camaDriveFolder;

const REQUIRED = [
  "OWNDATMAX.DAT",
  "ASMT.DAT",
  "PARDAT.DAT",
  "SALES.DAT",
  "DWELL.DAT",
  "CHARGE.DAT",
];
const MIN_BYTES = {
  "OWNDATMAX.DAT": 50_000_000,
  "ASMT.DAT": 10_000_000,
  "PARDAT.DAT": 10_000_000,
  "SALES.DAT": 1_000_000,
  "DWELL.DAT": 100_000_000,
  "CHARGE.DAT": 1_000_000,
};

function parseArgs() {
  const idx = process.argv.indexOf("--files");
  const list = idx >= 0 ? process.argv[idx + 1].split(",").map((s) => s.trim()) : REQUIRED;
  return { files: list };
}

export async function extractDriveFileMap(page) {
  await page.goto(CAMA_FOLDER, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const map = {};
    for (const row of document.querySelectorAll("[data-id]")) {
      const id = row.getAttribute("data-id");
      const text = row.textContent?.replace(/\s+/g, " ") ?? "";
      const name =
        text.split(" ").find((t) => t.endsWith(".DAT")) ??
        text.match(/AA407_layout[^\s]+/i)?.[0] ??
        text.match(/Charge_Layout[^\s]+/i)?.[0];
      if (id && name) map[name] = id;
    }
    return map;
  });
}

export async function downloadDriveFile(page, fileId, dest) {
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 600000 }),
      page.goto(downloadUrl, { waitUntil: "commit", timeout: 120000 }),
    ]);
    await download.saveAs(dest);
    return;
  } catch {
    // Fall through to virus-scan confirm or direct fetch.
  }

  await page.goto(downloadUrl, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
  const confirm = page.locator("form#download-form input[type='submit'], a#uc-download-link");
  if (await confirm.first().isVisible().catch(() => false)) {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 600000 }),
      confirm.first().click(),
    ]);
    await download.saveAs(dest);
    return;
  }
  const resp = await page.request.get(
    `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`,
    { timeout: 600000 }
  );
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
  const buf = Buffer.from(await resp.body());
  if (buf.toString("utf8", 0, 15).includes("<!DOCTYPE")) {
    throw new Error("Got HTML instead of file (virus scan page?)");
  }
  fs.writeFileSync(dest, buf);
}

async function main() {
  const { files } = parseArgs();
  fs.mkdirSync(CAMA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const map = fs.existsSync(DRIVE_MAP_PATH)
    ? JSON.parse(fs.readFileSync(DRIVE_MAP_PATH, "utf8"))
    : await extractDriveFileMap(page);
  fs.writeFileSync(DRIVE_MAP_PATH, JSON.stringify(map, null, 2));

  for (const name of files) {
    const dest = path.join(CAMA_DIR, name);
    const min = MIN_BYTES[name] ?? 1000;
    if (fs.existsSync(dest) && fs.statSync(dest).size >= min) {
      console.error(`Skip ${name} (${fs.statSync(dest).size} bytes)`);
      continue;
    }
    const id = map[name];
    if (!id) {
      console.error(`Missing drive id for ${name}`);
      continue;
    }
    console.error(`Downloading ${name}...`);
    await downloadDriveFile(page, id, dest);
    console.error(`  ${fs.statSync(dest).size} bytes`);
  }

  await browser.close();
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

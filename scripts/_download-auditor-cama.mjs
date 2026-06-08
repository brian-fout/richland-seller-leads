import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CAMA_DIR = path.join(DATA_DIR, "auditor-cama-download");

const FOLDER = "https://drive.google.com/drive/folders/1MylkuKvxVIUXKwyX5wogy6TSzD84Ihev";
const TARGET_FILES = ["ENTER.DAT", "AUPARCEL.DAT", "ASMT.DAT", "LEGDAT.DAT"];

async function downloadNamedFile(page, fileName) {
  await page.goto(FOLDER, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(3000);
  const row = page.getByText(fileName, { exact: true }).first();
  await row.click({ timeout: 30000 });
  await page.waitForTimeout(1500);

  const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
  await page.getByRole("button", { name: /download/i }).first().click({ timeout: 30000 }).catch(async () => {
    await page.locator('[data-tooltip="Download"]').first().click({ timeout: 30000 });
  });
  const download = await downloadPromise;
  const dest = path.join(CAMA_DIR, fileName);
  await download.saveAs(dest);
  return dest;
}

function searchDatFile(filePath, needles) {
  const buf = fs.readFileSync(filePath);
  const text = buf.toString("latin1");
  const hits = [];
  for (const needle of needles) {
    let idx = 0;
    while (true) {
      const at = text.indexOf(needle, idx);
      if (at < 0) break;
      hits.push({ needle, at, context: text.slice(Math.max(0, at - 80), at + 120).replace(/[\x00-\x1f]/g, " ") });
      idx = at + needle.length;
      if (hits.length > 20) break;
    }
  }
  return hits;
}

async function main() {
  fs.mkdirSync(CAMA_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const downloaded = [];
  for (const name of TARGET_FILES) {
    try {
      console.error(`Downloading ${name}...`);
      const dest = await downloadNamedFile(page, name);
      console.error(`  -> ${dest} (${fs.statSync(dest).size} bytes)`);
      downloaded.push(dest);
    } catch (err) {
      console.error(`  failed ${name}:`, err.message);
    }
  }

  await browser.close();

  const needles = [
    "0270404407000",
    "027-04-044-07",
    "252",
    "BOWMAN",
    "COLUMBUS HOUSING",
    "KYROU",
  ];

  for (const file of downloaded) {
    console.error(`\nSearching ${path.basename(file)}...`);
    const hits = searchDatFile(file, needles);
    console.log(JSON.stringify({ file: path.basename(file), hits: hits.slice(0, 10) }, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

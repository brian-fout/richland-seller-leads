import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CAMA_DIR = path.join(DATA_DIR, "auditor-cama-download");
const FOLDER = "https://drive.google.com/drive/folders/1MylkuKvxVIUXKwyX5wogy6TSzD84Ihev";

async function extractFileMap(page) {
  await page.goto(FOLDER, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(4000);
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-id]")];
    const map = {};
    for (const row of rows) {
      const id = row.getAttribute("data-id");
      const text = row.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (id && /\.DAT$/i.test(text)) map[text.split(" ").find((t) => t.endsWith(".DAT")) ?? text] = id;
    }
    return map;
  });
}

async function downloadById(page, fileId, dest) {
  const url = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
  const resp = await page.request.get(url, { timeout: 300000 });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
  fs.writeFileSync(dest, Buffer.from(await resp.body()));
}

function searchDat(filePath, needles) {
  const text = fs.readFileSync(filePath).toString("latin1");
  const hits = [];
  for (const needle of needles) {
    let idx = 0;
    while (hits.length < 15) {
      const at = text.indexOf(needle, idx);
      if (at < 0) break;
      hits.push({
        needle,
        context: text.slice(Math.max(0, at - 100), at + 150).replace(/[\x00-\x08\x0b-\x1f]/g, " "),
      });
      idx = at + needle.length;
    }
  }
  return hits;
}

async function main() {
  fs.mkdirSync(CAMA_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const map = await extractFileMap(page);
  fs.writeFileSync(path.join(CAMA_DIR, "drive-file-map.json"), JSON.stringify(map, null, 2));
  console.error("Files found:", Object.keys(map).length);

  const targets = ["ENTER.DAT", "AUPARCEL.DAT", "ASMT.DAT"];
  const needles = ["0270404407000", "0270404407", "252", "BOWMAN", "COLUMBUS HOUSING", "KYROU"];

  for (const name of targets) {
    const id = map[name];
    if (!id) {
      console.error(`Missing ${name}`);
      continue;
    }
    const dest = path.join(CAMA_DIR, name);
    console.error(`Downloading ${name} (${id})...`);
    await downloadById(page, id, dest);
    console.error(`  ${fs.statSync(dest).size} bytes`);
    const hits = searchDat(dest, needles);
    console.log(JSON.stringify({ file: name, hitCount: hits.length, hits: hits.slice(0, 8) }, null, 2));
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

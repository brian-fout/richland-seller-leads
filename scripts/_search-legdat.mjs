import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMA_DIR = path.join(__dirname, "..", "data", "auditor-cama-download");
const map = JSON.parse(fs.readFileSync(path.join(CAMA_DIR, "drive-file-map.json"), "utf8"));

async function downloadById(page, fileId, dest) {
  const url = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
  const resp = await page.request.get(url, { timeout: 300000 });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
  fs.writeFileSync(dest, Buffer.from(await resp.body()));
}

function search(filePath, needles) {
  const text = fs.readFileSync(filePath).toString("latin1");
  const results = [];
  for (const needle of needles) {
    let idx = 0;
    while (results.length < 5) {
      const at = text.indexOf(needle, idx);
      if (at < 0) break;
      results.push({
        needle,
        context: text.slice(Math.max(0, at - 90), at + 160).replace(/[\x00-\x08\x0b-\x1f]/g, " "),
      });
      idx = at + needle.length;
    }
  }
  return results;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const files = ["OWNDAT.DAT", "MAILDAT.DAT", "SALES.DAT", "PARDAT.DAT", "LEGDAT.DAT"];
const needles = ["0270404407000", "COLUMBUS HOUSING", "KYROU", "BOWMAN", "35000", "5/2/2024", "02-MAY-24", "MAY-24"];

for (const name of files) {
  const dest = path.join(CAMA_DIR, name);
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    console.error("Downloading", name, "...");
    await downloadById(page, map[name], dest);
  }
  console.error(`${name}: ${fs.statSync(dest).size} bytes`);
  const hits = search(dest, needles);
  console.log(JSON.stringify({ file: name, hits }, null, 2));
}
await browser.close();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMA_DIR = path.join(__dirname, "..", "data", "auditor-cama-download");
const map = JSON.parse(fs.readFileSync(path.join(CAMA_DIR, "drive-file-map.json"), "utf8"));

async function downloadLarge(page, fileId, dest) {
  await page.goto(`https://drive.google.com/uc?export=download&id=${fileId}`, {
    waitUntil: "commit",
    timeout: 120000,
  });
  const confirm = page.locator("form#download-form input[type='submit'], a#uc-download-link");
  if (await confirm.first().isVisible().catch(() => false)) {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 300000 }),
      confirm.first().click(),
    ]);
    await download.saveAs(dest);
    return;
  }
  const resp = await page.request.get(`https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`, {
    timeout: 300000,
  });
  fs.writeFileSync(dest, Buffer.from(await resp.body()));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const dest = path.join(CAMA_DIR, "OWNDATMAX.DAT");
console.error("Downloading OWNDATMAX.DAT...");
await downloadLarge(page, map["OWNDATMAX.DAT"], dest);
console.error("Size:", fs.statSync(dest).size);
const head = fs.readFileSync(dest, "utf8").slice(0, 80);
console.error("Head:", head);
const text = fs.readFileSync(dest).toString("latin1");
for (const n of ["0270404407000", "COLUMBUS HOUSING", "KYROU", "252"]) {
  const at = text.indexOf(n);
  console.log(n, at >= 0 ? text.slice(Math.max(0, at - 80), at + 140).replace(/[\x00-\x1f]/g, " ") : "NOT FOUND");
}
await browser.close();

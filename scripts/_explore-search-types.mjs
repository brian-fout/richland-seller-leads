import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://countyfusion13.kofiletech.us/countyweb";

async function loginGuest(page) {
  await page.goto(`${BASE}/loginDisplay.action?countyname=RichlandOH`, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('input[value*="Guest" i]').first().click();
  await page.waitForTimeout(2000);
  await page.frame({ name: "bodyframe" }).locator('input[type="button"][value="Accept"]').click();
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const d = document.getElementById("disablediv");
    if (d) d.style.visibility = "hidden";
  });
  await page.frame({ name: "bodyframe" }).locator('[datagrid-row-index="0"]').click();
  await page.waitForTimeout(6000);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await loginGuest(page);

const searchTypes = [
  "allNames",
  "documentType",
  "docType",
  "instrumentType",
  "instrument",
  "legal",
  "bookPage",
  "recordDate",
  "recordedDate",
];

for (const st of searchTypes) {
  const url = `${BASE}/search/dyncriteria/dynCriteria.do?searchType=${st}&searchCategory=ADVANCED`;
  const frame = page.frames().find((f) => f.url().includes("searchCriteria.do"));
  if (!frame) continue;
  const child = frame.childFrames().find((f) => f.url().includes("dynCriteria.do"));
  if (child) {
    try {
      await child.goto(url);
      await page.waitForTimeout(2000);
      const text = await child.innerText("body");
      const selects = await child.$$eval("select", (els) =>
        els.map((s) => ({ name: s.name, id: s.id, options: [...s.options].map((o) => o.text.trim()) }))
      );
      console.log("\n===", st, "===");
      console.log(text.slice(0, 800));
      console.log("selects:", selects);
    } catch (e) {
      console.log(st, e.message);
    }
  }
}

// Save navbar links
const nav = page.frames().find((f) => f.url().includes("navbar.do"));
if (nav) {
  const links = await nav.$$eval("a", (els) => els.map((a) => ({ href: a.href, text: a.textContent?.trim() })));
  console.log("\nNavbar:", links);
  fs.writeFileSync(path.join(__dirname, "..", "data", "_recorder-navbar.html"), await nav.content());
}

await browser.close();

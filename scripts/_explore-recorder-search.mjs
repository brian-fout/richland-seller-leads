import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://countyfusion13.kofiletech.us/countyweb";

function getFrame(page) {
  return page.frame({ name: "bodyframe" });
}

async function loginGuest(page) {
  await page.goto(`${BASE}/loginDisplay.action?countyname=RichlandOH`, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('input[value*="Guest" i]').first().click();
  await page.waitForTimeout(2000);
  await getFrame(page).locator('input[type="button"][value="Accept"]').click();
  await page.waitForTimeout(3000);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await loginGuest(page);

await page.evaluate(() => {
  const d = document.getElementById("disablediv");
  if (d) d.style.visibility = "hidden";
});

await getFrame(page).locator('[datagrid-row-index="0"]').click();
await page.waitForTimeout(6000);

const frame = getFrame(page);
console.log("URL:", frame.url());
const text = await frame.innerText("body");
console.log(text.slice(0, 6000));

const selects = await frame.$$eval("select", (els) =>
  els.map((s) => ({
    name: s.name,
    id: s.id,
    options: [...s.options].map((o) => ({ value: o.value, text: o.text.trim() })),
  }))
);
for (const s of selects) {
  if (s.options.length) {
    console.log(`\nSelect ${s.name || s.id}:`);
    s.options
      .filter((o) => /lis|pendens|foreclos|mortgage|notice/i.test(o.text))
      .forEach((o) => console.log(" ", o));
  }
}

fs.writeFileSync(path.join(__dirname, "..", "data", "_recorder-search.html"), await frame.content());

// If there's a doc type select, try LIS PENDENS search for last 90 days
const docSelect = selects.find((s) => s.options.some((o) => /lis pendens/i.test(o.text)));
if (docSelect) {
  const lisValue = docSelect.options.find((o) => /lis pendens/i.test(o.text) && !/discharge/i.test(o.text))?.value;
  console.log("\nLis pendens value:", lisValue);

  const sel = `#${docSelect.id || ""}, select[name="${docSelect.name || ""}"]`;
  if (docSelect.id) await frame.selectOption(`#${docSelect.id}`, lisValue);

  // Fill date range if present
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 90);
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

  for (const [name, val] of [
    ["startDate", fmt(start)],
    ["endDate", fmt(today)],
    ["fromDate", fmt(start)],
    ["toDate", fmt(today)],
    ["recordingDateFrom", fmt(start)],
    ["recordingDateTo", fmt(today)],
  ]) {
    const loc = frame.locator(`input[name="${name}"], input[id="${name}"]`);
    if (await loc.count()) await loc.fill(val);
  }

  const searchBtn = frame.locator('input[type="submit"], input[value*="Search" i], button:has-text("Search")').first();
  if (await searchBtn.count()) {
    await searchBtn.click();
    await page.waitForTimeout(8000);
    console.log("\nResults URL:", getFrame(page).url());
    console.log((await getFrame(page).innerText("body")).slice(0, 5000));
    fs.writeFileSync(path.join(__dirname, "..", "data", "_recorder-results.html"), await getFrame(page).content());
  }
}

await browser.close();

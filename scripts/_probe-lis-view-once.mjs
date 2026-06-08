import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const LOGIN_URL = "https://countyfusion13.kofiletech.us/countyweb/loginDisplay.action?countyname=RichlandOH";

function findFrame(page, pred) {
  for (const frame of page.frames()) {
    if (pred(frame)) return frame;
  }
  return null;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 90000 });
await page.locator('input[value*="Guest" i]').first().click();
await page.waitForTimeout(2000);
await page.frame({ name: "bodyframe" }).locator('input[type="button"][value="Accept"]').click();
await page.waitForTimeout(3000);
await page.frame({ name: "bodyframe" }).locator('[datagrid-row-index="0"]').click();
await page.waitForTimeout(6000);

const criteria = findFrame(page, (f) => f.url().includes("searchCriteria.do"));
const dyn = findFrame(page, (f) => f.url().includes("dynCriteria.do"));
const body = page.frame({ name: "bodyframe" });

await criteria.evaluate(() => {
  const root = $("#instTree").tree("getRoot");
  $("#instTree").tree("uncheck", root.target);
  $("#instTree").tree("collapseAll", root.target);
  $("#instTree").tree("expand", root.target);
  function walk(node) {
    for (const child of $("#instTree").tree("getChildren", node.target)) {
      if ((child.text || "").toUpperCase().includes("LIENS")) $("#instTree").tree("expand", child.target);
      walk(child);
    }
  }
  walk(root);
  function check(node) {
    for (const child of $("#instTree").tree("getChildren", node.target)) {
      const label = (child.text || "").trim().toUpperCase();
      if (label === "LIS PENDENS" || label === "LIS PENDENS NC") $("#instTree").tree("check", child.target);
      check(child);
    }
  }
  check(root);
});
await dyn.evaluate(() => {
  $("#FROMDATE").datebox("setValue", "01/01/2025");
  $("#TODATE").datebox("setValue", "12/31/2025");
});
await criteria.evaluate(() => {
  executing = false;
  executeCommand("search");
});
await page.waitForTimeout(15000);

const clicked = await body.evaluate(() => {
  const list = window.frames["resultFrame"]?.frames["resultListFrame"];
  const link = list?.document.querySelector('tr[datagrid-row-index="0"] td[field="12"] a');
  if (!link) return null;
  link.click();
  return link.innerText;
});
await page.waitForTimeout(10000);

const texts = [];
for (const f of page.frames()) {
  try {
    const t = await f.innerText("body");
    if (/address|street|situs|parcel|subdivision|lot |acres|legal|property/i.test(t)) {
      texts.push({ url: f.url().slice(0, 180), name: f.name(), text: t.slice(0, 8000) });
    }
  } catch {
    // ignore
  }
}

console.log("clicked View:", clicked);
console.log("interesting frames:", texts.length);
for (const t of texts) {
  console.log("\n---", t.url);
  console.log(t.text.slice(0, 2000));
}

fs.writeFileSync(path.join(OUT, "_probe-lis-view-once.json"), JSON.stringify({ clicked, texts }, null, 2));
await browser.close();

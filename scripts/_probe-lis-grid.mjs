import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");
const LOGIN_URL = "https://countyfusion13.kofiletech.us/countyweb/loginDisplay.action?countyname=RichlandOH";

async function retry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

function findFrame(page, pred) {
  for (const frame of page.frames()) {
    if (pred(frame)) return frame;
  }
  return null;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await retry(() => page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 90000 }));
await page.locator('input[value*="Guest" i]').first().click();
await page.waitForTimeout(2000);
await page.frame({ name: "bodyframe" }).locator('input[type="button"][value="Accept"]').click();
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const overlay = document.getElementById("disablediv");
  if (overlay) overlay.style.visibility = "hidden";
});
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
      const label = (child.text || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (label === "LIENS") $("#instTree").tree("expand", child.target);
      walk(child);
    }
  }
  walk(root);
  function checkMatches(node) {
    for (const child of $("#instTree").tree("getChildren", node.target)) {
      const label = (child.text || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (label === "LIS PENDENS" || label === "LIS PENDENS NC") $("#instTree").tree("check", child.target);
      checkMatches(child);
    }
  }
  checkMatches(root);
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

const grid = await body.evaluate(() => {
  const list = window.frames["resultFrame"]?.frames["resultListFrame"];
  if (!list) return { error: "no list" };

  const headers = [...list.document.querySelectorAll("div.datagrid-header td[field]")].map((td) => ({
    field: td.getAttribute("field"),
    text: td.innerText?.trim(),
  }));

  const rows = [];
  for (const tr of list.document.querySelectorAll("tr[datagrid-row-index]")) {
    const inner = tr.querySelector("table tbody tr");
    if (!inner) continue;
    const row = {};
    inner.querySelectorAll("td[field]").forEach((td) => {
      row[td.getAttribute("field")] = (td.innerText || td.textContent || "").trim();
    });
    rows.push(row);
    if (rows.length >= 2) break;
  }
  return { headers, rows };
});

console.log(JSON.stringify(grid, null, 2));
fs.writeFileSync(path.join(OUT, "_probe-lis-grid.json"), JSON.stringify(grid, null, 2));

// Click first instrument number link / View
const clickResult = await body.evaluate(() => {
  const list = window.frames["resultFrame"]?.frames["resultListFrame"];
  const link =
    list?.document.querySelector('td[field="2"] a') ||
    list?.document.querySelector('td[field="12"] a') ||
    list?.document.querySelector("a[onclick*='showDocument']");
  if (!link) return { clicked: false };
  link.click();
  return { clicked: true, text: link.innerText, onclick: link.getAttribute("onclick")?.slice(0, 300) };
});

await page.waitForTimeout(8000);

const framesAfter = [];
for (const f of page.frames()) {
  let text = "";
  try {
    text = (await f.innerText("body")).slice(0, 4000);
  } catch {
    // ignore
  }
  if (/address|street|situs|parcel|legal|property/i.test(text)) {
    framesAfter.push({ url: f.url().slice(0, 150), name: f.name(), text });
  }
}

console.log("\nClick:", JSON.stringify(clickResult, null, 2));
console.log("\nFrames with address-ish text:", JSON.stringify(framesAfter, null, 2));
fs.writeFileSync(path.join(OUT, "_probe-lis-detail.json"), JSON.stringify({ clickResult, framesAfter }, null, 2));

await browser.close();

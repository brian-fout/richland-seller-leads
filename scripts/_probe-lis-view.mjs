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

async function setupSearch(page) {
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
  return body;
}

async function collectInterestingText(page) {
  const hits = [];
  for (const f of page.frames()) {
    let text = "";
    try {
      text = await f.innerText("body");
    } catch {
      continue;
    }
    if (/street|situs|property address|parcel|subdivision|lot \d/i.test(text)) {
      hits.push({ url: f.url().slice(0, 180), name: f.name(), text: text.slice(0, 5000) });
    }
  }
  return hits;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const body = await setupSearch(page);

const attempts = [
  {
    label: "click View link in field 12",
    fn: () =>
      body.evaluate(() => {
        const list = window.frames["resultFrame"]?.frames["resultListFrame"];
        const link = list?.document.querySelector('tr[datagrid-row-index="0"] td[field="12"] a');
        if (!link) return false;
        link.click();
        return true;
      }),
  },
  {
    label: "double-click first data row",
    fn: () =>
      body.evaluate(() => {
        const list = window.frames["resultFrame"]?.frames["resultListFrame"];
        const row = list?.document.querySelector('tr[datagrid-row-index="0"]');
        if (!row) return false;
        row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        return true;
      }),
  },
  {
    label: "click instrument number cell link",
    fn: () =>
      body.evaluate(() => {
        const list = window.frames["resultFrame"]?.frames["resultListFrame"];
        const cell = list?.document.querySelector('tr[datagrid-row-index="0"] td[field="2"]');
        const link = cell?.querySelector("a") || cell;
        if (!link) return false;
        link.click();
        return true;
      }),
  },
];

for (const attempt of attempts) {
  await setupSearch(page);
  const ok = await attempt.fn();
  await page.waitForTimeout(8000);
  const hits = await collectInterestingText(page);
  console.error(`\n=== ${attempt.label} (clicked=${ok}) hits=${hits.length} ===`);
  for (const h of hits.slice(0, 3)) {
    console.error(h.url);
    console.error(h.text.slice(0, 800));
    console.error("---");
  }
  fs.writeFileSync(
    path.join(OUT, `_probe-lis-${attempt.label.replace(/\W+/g, "-").toLowerCase()}.json`),
    JSON.stringify(hits, null, 2)
  );
}

await browser.close();

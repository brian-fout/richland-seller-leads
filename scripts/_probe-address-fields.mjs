/**
 * One-off probe: do lis pendens / probate detail pages expose street addresses?
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data");

async function probeLisPendens(page) {
  const BASE = "https://countyfusion13.kofiletech.us/countyweb";
  await page.goto(`${BASE}/loginDisplay.action?countyname=RichlandOH`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.getByRole("link", { name: /guest/i }).click().catch(() => null);
  await page.waitForTimeout(3000);

  const body = page.frames().find((f) => f.name() === "bodyframe" || /SearchMainView/i.test(f.url()));
  const criteria = page.frames().find((f) => /SearchCriteria/i.test(f.url()));
  const dyn = page.frames().find((f) => /DynamicCriteria/i.test(f.url()));
  if (!criteria || !dyn || !body) throw new Error("Recorder frames not found");

  await criteria.evaluate(() => {
    executing = false;
    executeCommand("selectDocType", "LIS PENDENS");
    executeCommand("selectDocType", "LIS PENDENS NC");
    $("#FROMDATE").datebox("setValue", "01/01/2025");
    $("#TODATE").datebox("setValue", "12/31/2025");
    executeCommand("search");
  });

  await page.waitForTimeout(12000);

  const gridInfo = await body.evaluate(() => {
    const list = window.frames["resultFrame"]?.frames["resultListFrame"];
    if (!list) return { error: "no list frame", frames: Object.keys(window.frames) };

    const headers = [];
    list.document.querySelectorAll("div.datagrid-header td[field]").forEach((td) => {
      headers.push({ field: td.getAttribute("field"), text: td.innerText?.trim() });
    });

    const firstRow = list.document.querySelector("tr[datagrid-row-index]");
    const cells = {};
    if (firstRow) {
      firstRow.querySelectorAll("td[field]").forEach((td) => {
        cells[td.getAttribute("field")] = (td.innerText || td.textContent || "").trim().slice(0, 200);
      });
    }

    const refHtml = firstRow?.querySelector('td[field="12"]')?.innerHTML?.slice(0, 500) ?? null;
    return { headers, cells, refHtml, rowCount: list.documentRowInfo?.length ?? 0 };
  });

  fs.writeFileSync(path.join(OUT, "_probe-lis-grid.json"), JSON.stringify(gridInfo, null, 2));

  // Try opening first instrument detail via View link
  const detail = await body.evaluate(() => {
    const list = window.frames["resultFrame"]?.frames["resultListFrame"];
    const link = list?.document.querySelector('td[field="12"] a, td[field="2"] a, a[onclick*="inst"]');
    if (!link) return { clicked: false };
    link.click();
    return { clicked: true, href: link.getAttribute("href"), onclick: link.getAttribute("onclick")?.slice(0, 200) };
  });

  await page.waitForTimeout(5000);
  const allFrameText = page.frames().map((f) => ({
    name: f.name(),
    url: f.url().slice(0, 120),
    text: "",
  }));

  for (const info of allFrameText) {
    const frame = page.frames().find((f) => f.url() === info.url);
    if (!frame) continue;
    try {
      info.text = (await frame.innerText("body")).slice(0, 3000);
    } catch {
      // ignore
    }
  }

  fs.writeFileSync(path.join(OUT, "_probe-lis-detail.json"), JSON.stringify({ detail, frames: allFrameText }, null, 2));
  return gridInfo;
}

async function probeProbate(page) {
  const BASE = "https://probatecourt.richlandcountyoh.gov";
  const detailUrl = JSON.parse(
    fs.readFileSync(path.join(OUT, "probate-estates-canonical.json"), "utf8")
  )[0].detail_url;

  await page.goto(`${BASE}/recordSearch.php`, { waitUntil: "domcontentloaded", timeout: 90000 });
  const cont = page.getByRole("link", { name: /continue/i });
  if (await cont.count()) await cont.click().catch(() => null);
  await page.waitForTimeout(1000);

  await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2000);

  const html = await page.content();
  const text = await page.innerText("body");
  fs.writeFileSync(path.join(OUT, "_probe-probate-detail.html"), html);

  const $ = cheerio.load(html);
  const hits = [];
  $("dt, th, label, .caseField, h3, h4").each((_, el) => {
    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (/address|property|residence|real estate|parcel|location|situs|street/i.test(label)) {
      const next =
        $(el).next("dd").text().trim() ||
        $(el).parent().find("td").last().text().trim() ||
        $(el).closest("tr").find("td").last().text().trim();
      hits.push({ label, value: next.slice(0, 300) });
    }
  });

  return {
    title: $("title").text(),
    hasCaptcha: /captcha/i.test(text),
    addressHits: hits,
    textSample: text.slice(0, 2500),
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

console.error("=== Lis pendens grid ===");
try {
  const lis = await probeLisPendens(page);
  console.error(JSON.stringify(lis, null, 2));
} catch (err) {
  console.error("Lis pendens probe failed:", err.message);
}

console.error("\n=== Probate detail ===");
try {
  const prob = await probeProbate(page);
  console.error(JSON.stringify(prob, null, 2));
} catch (err) {
  console.error("Probate probe failed:", err.message);
}

await browser.close();

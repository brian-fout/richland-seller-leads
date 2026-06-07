import { chromium } from "playwright";

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

const paths = [
  "/search/instrumentTypes.do",
  "/search/getInstrumentTypes.do",
  "/search/filterCriteria.do",
  "/search/filterResults.do",
  "/search/docTypes.do",
  "/instrumentTypes.jsp",
  "/search/dyncriteria/instrumentTypes.do",
];

for (const p of paths) {
  try {
    const resp = await page.request.get(BASE + p);
    const text = await resp.text();
    if (resp.status() === 200 && text.length > 50 && !/404|error/i.test(text.slice(0, 200))) {
      console.log("\n===", p, "status", resp.status(), "len", text.length, "===");
      console.log(text.slice(0, 1500));
      if (/lis|pendens/i.test(text)) console.log("*** HAS LIS PENDENS ***");
    }
  } catch (e) {
    console.log(p, e.message);
  }
}

await browser.close();

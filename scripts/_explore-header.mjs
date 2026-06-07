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

const header = page.frames().find((f) => f.url().includes("header.do"));
if (header) {
  console.log("Header text:", (await header.innerText("body")).slice(0, 2000));
  const selects = await header.$$eval("select", (els) =>
    els.map((s) => ({ name: s.name, id: s.id, options: [...s.options].map((o) => ({ v: o.value, t: o.text.trim() })) }))
  );
  console.log("Header selects:", JSON.stringify(selects, null, 2));
}

const criteria = page.frames().find((f) => f.url().includes("searchCriteria.do"));
if (criteria) {
  const html = await criteria.content();
  const matches = [...html.matchAll(/searchType[=:][\"']([^\"']+)[\"']/g)].map((m) => m[1]);
  console.log("\nsearchType values in criteria HTML:", [...new Set(matches)]);
  const lis = [...html.matchAll(/LIS[^\"']{0,20}/gi)].slice(0, 20);
  console.log("LIS matches:", lis.map((m) => m[0]));
}

await browser.close();

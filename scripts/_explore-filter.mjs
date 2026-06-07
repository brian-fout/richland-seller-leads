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

const criteria = page.frames().find((f) => f.url().includes("searchCriteria.do"));
const dyn = criteria.childFrames().find((f) => f.url().includes("dynCriteria.do"));

// Open Filter Results if it's a link/button
const filterLink = dyn.getByText(/Filter Results/i);
if (await filterLink.count()) {
  await filterLink.click();
  await page.waitForTimeout(2000);
  console.log("After filter click:", (await dyn.innerText("body")).slice(0, 2000));
}

// Click each tab and dump content keywords
const tabs = await criteria.locator(".tabs-title").all();
for (let i = 0; i < tabs.length; i++) {
  await tabs[i].click();
  await page.waitForTimeout(2000);
  const text = await dyn.innerText("body");
  console.log(`\nTab ${i}:`, (await tabs[i].innerText()).trim());
  console.log(text.slice(0, 600));
  const selects = await dyn.$$eval("select", (els) =>
    els.map((s) => ({ id: s.id, name: s.name, options: [...s.options].map((o) => o.text.trim()).slice(0, 15) }))
  );
  if (selects.length) console.log("selects", selects);
}

await browser.close();

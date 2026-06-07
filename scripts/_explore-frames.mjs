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

function walkFrames(frame, depth = 0) {
  console.log(" ".repeat(depth * 2) + "Frame:", frame.url());
  return frame.childFrames().flatMap((c) => walkFrames(c, depth + 1));
}

const body = page.frame({ name: "bodyframe" });
walkFrames(body);

for (const frame of page.frames()) {
  if (!frame.url().includes("countyfusion")) continue;
  try {
    const selects = await frame.$$eval("select", (els) =>
      els.map((s) => ({
        name: s.name,
        id: s.id,
        options: [...s.options].map((o) => o.text.trim()).filter(Boolean),
      }))
    );
    if (selects.length) {
      console.log("\nFrame selects:", frame.url());
      for (const s of selects) {
        const lis = s.options.filter((o) => /lis|pendens|doc|type|instrument/i.test(o));
        if (lis.length) console.log(s.name || s.id, lis.slice(0, 20));
      }
    }
    const text = await frame.innerText("body");
    if (/lis pendens/i.test(text)) {
      console.log("\nLIS PENDENS in frame:", frame.url());
      const idx = text.toLowerCase().indexOf("lis pendens");
      console.log(text.slice(Math.max(0, idx - 100), idx + 300));
    }
  } catch {}
}

await browser.close();

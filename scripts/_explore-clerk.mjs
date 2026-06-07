import { chromium } from "playwright";

const CLERK = "https://eservices.richlandcountycpcourt.org/eservices/home.page";

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const page = await browser.newPage();
try {
  const resp = await page.goto(CLERK, { waitUntil: "networkidle", timeout: 90000 });
  console.log("Status", resp?.status(), "Title", await page.title());
  console.log((await page.innerText("body")).slice(0, 3000));
  const links = await page.$$eval("a", (els) =>
    els.map((a) => ({ href: a.href, text: (a.textContent || "").replace(/\s+/g, " ").trim() })).filter((l) => l.text)
  );
  console.log("\nLinks:", links.slice(0, 40));
} catch (e) {
  console.log("ERR", e.message);
}
await browser.close();

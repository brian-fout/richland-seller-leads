import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const PAGES = [
  "https://www.richlandcountyoh.gov/departments/auditor/CamaData",
  "https://www.richlandcountyoh.gov/departments/auditor/camadata",
];

const GUESSES = [
  "https://www.richlandcountyoh.gov/media/CamaUpdate.zip",
  "https://www.richlandcountyoh.gov/media/camaupdate.zip",
  "https://www.richlandcountyoh.gov/media/Uploads/CamaUpdate.zip",
  "https://www.richlandcountyoh.gov/media/Uploads/cama_update.zip",
  "https://www.richlandcountyoh.gov/media/Design_files/CamaUpdate.zip",
  "https://maps.richlandcountyoh.us/cama/CamaUpdate.zip",
  "https://share.pivotpoint.us/oh/richland/cama/cama_data.zip",
];

async function fetchPage(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" },
    redirect: "follow",
  });
  const html = await r.text();
  return { status: r.status, url: r.url, html };
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    try {
      links.add(new URL(m[1], baseUrl).href);
    } catch {
      // ignore
    }
  }
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:zip|csv|txt|xlsx|xls)/gi)) {
    links.add(m[0]);
  }
  return [...links].filter((l) => /cama|shape|zip|csv|update|charge|download|media|\.x/i.test(l));
}

console.error("=== Pages ===");
for (const url of PAGES) {
  const { status, url: finalUrl, html } = await fetchPage(url);
  const out = path.join(DATA_DIR, "_cama-page.html");
  fs.writeFileSync(out, html);
  const title = html.match(/id="evo_interior_title"[^>]*>([^<]+)/)?.[1]?.trim();
  console.error(`${status} ${finalUrl} title="${title ?? "?"}" len=${html.length}`);
  const links = extractLinks(html, finalUrl);
  console.log("PAGE_LINKS", finalUrl);
  for (const l of links) console.log(l);
}

console.error("\n=== URL guesses ===");
for (const url of GUESSES) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });
    console.log(r.status, r.headers.get("content-type"), r.headers.get("content-length"), url);
  } catch (err) {
    console.log("ERR", url, err.message);
  }
}

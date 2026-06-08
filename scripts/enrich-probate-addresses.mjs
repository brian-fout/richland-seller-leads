/**
 * Fetch decedent addresses from probate case detail pages.
 *
 * Detail URLs do not require CAPTCHA. Updates day files and canonical.
 *
 * Usage:
 *   npm run enrich:probate-addresses
 *   node scripts/enrich-probate-addresses.mjs --force
 *   node scripts/enrich-probate-addresses.mjs --limit 10
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  loadAllDayRecords,
  writeCanonicalFromDays,
  mergeByKey,
} from "./scrape-state.mjs";
import {
  parseProbateDetail,
  mergeProbateDetail,
  needsProbateDetail,
} from "./probate-detail.mjs";
import { openSearchForm } from "./probate-session.mjs";
import { paths } from "../src/core/county-context.mjs";

const DATA_DIR = paths().dataRoot;
const BASE_NAME = "probate-estates";

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;
  return {
    force: process.argv.includes("--force"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
  };
}

function dayFiles() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(`${BASE_NAME}-day-`) && f.endsWith(".json"))
    .sort();
}

function rewriteDayFiles(enrichedByCase) {
  for (const file of dayFiles()) {
    const filePath = path.join(DATA_DIR, file);
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const updated = rows.map((row) => enrichedByCase.get(row.case_number) ?? row);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
  }
}

async function fetchDetail(page, detailUrl) {
  await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#caseInformation, #captchaImage", { timeout: 15000 }).catch(() => null);
  const html = await page.content();
  return parseProbateDetail(html);
}

export async function enrichProbateRecords(page, records, options = {}) {
  const { force = false, delayMs = 400 } = options;
  await openSearchForm(page, page.context());

  const out = new Map();

  for (const record of records) {
    out.set(record.case_number, record);
  }

  const todo = records.filter((r) => needsProbateDetail(r, { force }));
  const queue = options.limit ? todo.slice(0, options.limit) : todo;
  let done = 0;
  let withAddress = 0;
  let skipped = 0;

  for (const record of queue) {
    try {
      const detail = await fetchDetail(page, record.detail_url);
      if (detail.error) {
        console.error(`  Skipped ${record.case_number} — ${detail.error}`);
        skipped++;
        continue;
      }
      const merged = mergeProbateDetail(record, detail);
      out.set(record.case_number, merged);
      if (merged.street_address) withAddress++;
    } catch (err) {
      console.error(`  Failed ${record.case_number}: ${err.message}`);
      skipped++;
    }

    done++;
    if (done % 25 === 0) {
      console.error(`  Details ${done}/${queue.length}...`);
    }
    if (delayMs > 0) await page.waitForTimeout(delayMs);
  }

  return {
    records: [...out.values()],
    enrichedByCase: out,
    stats: { todo: queue.length, done, withAddress, skipped },
  };
}

async function main() {
  const options = parseArgs();
  const allRecords = loadAllDayRecords(BASE_NAME, (r) => r.case_number);

  console.error(`Probate address enrichment: ${allRecords.length} canonical case(s)`);
  const needing = allRecords.filter((r) => needsProbateDetail(r, { force: options.force }));
  if (needing.length === 0) {
    const withAddr = allRecords.filter((r) => r.street_address).length;
    console.error(`Already enriched — ${withAddr}/${allRecords.length} with street address`);
    return;
  }
  console.error(`Fetching ${options.limit ? Math.min(options.limit, needing.length) : needing.length} detail page(s)...`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage();

  try {
    const { enrichedByCase, stats } = await enrichProbateRecords(page, allRecords, {
      force: options.force,
      limit: options.limit,
    });

    rewriteDayFiles(enrichedByCase);

    const canonical = mergeByKey([], [...enrichedByCase.values()], (r) => r.case_number);
    const { canonicalJson, canonicalCsv } = writeCanonicalFromDays(BASE_NAME, (r) => r.case_number);

    const withAddr = canonical.filter((r) => r.street_address).length;
    console.error(`Fetched details:   ${stats.done}`);
    console.error(`With street addr:  ${withAddr}/${canonical.length}`);
    console.error(`Skipped/failed:    ${stats.skipped}`);
    console.error(`Wrote ${canonicalJson}`);
    console.error(`Wrote ${canonicalCsv}`);
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1]?.endsWith("enrich-probate-addresses.mjs");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

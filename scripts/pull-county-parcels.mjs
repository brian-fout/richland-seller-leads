/**
 * @county richland — Pull Parcel_CAMA attributes for every parcel in the county GIS.
 *
 * Used as the comp universe for ARV work — not limited to distress leads.
 * Stores full raw CAMA plus a slim comp-oriented index.
 *
 * Usage:
 *   npm run pull:county-parcels
 *   node scripts/pull-county-parcels.mjs --geometry
 *   node scripts/pull-county-parcels.mjs --force
 *   node scripts/pull-county-parcels.mjs --limit-pages 2
 */

import fs from "fs";
import path from "path";
import { paths } from "../src/core/county-context.mjs";
import {
  queryCamaParcelCount,
  queryCamaParcelPage,
  toCompRecord,
} from "./auditor-cama.mjs";

const p = paths();
const OUT_DIR = p.countyParcels;
const FULL_JSONL = path.join(OUT_DIR, "cama-full.jsonl");
const COMP_JSONL = p.compIndex;
const MANIFEST_JSON = path.join(OUT_DIR, "manifest.json");
const STATE_JSON = path.join(OUT_DIR, "pull-state.json");

const PAGE_SIZE = 1000;

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit-pages");
  const delayIdx = process.argv.indexOf("--delay-ms");
  const pageSizeIdx = process.argv.indexOf("--page-size");
  const limitPages = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;
  const delayMs = delayIdx >= 0 ? parseInt(process.argv[delayIdx + 1], 10) : 150;
  const pageSize = pageSizeIdx >= 0 ? parseInt(process.argv[pageSizeIdx + 1], 10) : PAGE_SIZE;
  return {
    force: process.argv.includes("--force"),
    geometry: process.argv.includes("--geometry"),
    limitPages: Number.isFinite(limitPages) && limitPages > 0 ? limitPages : null,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 150,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 2000) : PAGE_SIZE,
  };
}

function loadState() {
  if (!fs.existsSync(STATE_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_JSON, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_JSON, JSON.stringify(state, null, 2));
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_JSON, JSON.stringify(manifest, null, 2));
}

function initOutputs({ force }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (force) {
    for (const file of [FULL_JSONL, COMP_JSONL, STATE_JSON, MANIFEST_JSON]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

function appendLines(filePath, lines) {
  if (!lines.length) return;
  fs.appendFileSync(filePath, `${lines.join("\n")}\n`);
}

function summarizeStats(stats) {
  return {
    ...stats,
    with_sale_price: stats.with_sale_price,
    with_sale_date: stats.with_sale_date,
    with_coordinates: stats.with_coordinates,
    likely_vacant_land: stats.likely_vacant_land,
    has_improvements: stats.has_improvements,
  };
}

async function main() {
  const args = parseArgs();
  initOutputs({ force: args.force });

  const prior = args.force ? null : loadState();
  let offset = prior?.next_offset ?? 0;
  let pulled = prior?.pulled ?? 0;
  const stats = {
    pulled: prior?.stats?.pulled ?? 0,
    with_sale_price: prior?.stats?.with_sale_price ?? 0,
    with_sale_date: prior?.stats?.with_sale_date ?? 0,
    with_coordinates: prior?.stats?.with_coordinates ?? 0,
    likely_vacant_land: prior?.stats?.likely_vacant_land ?? 0,
    has_improvements: prior?.stats?.has_improvements ?? 0,
  };

  const totalCount = await queryCamaParcelCount();
  const totalPages = Math.ceil(totalCount / args.pageSize);
  let pagesDone = Math.floor(offset / args.pageSize);

  console.error("County parcel CAMA pull");
  console.error(`  Total parcels (API): ${totalCount}`);
  console.error(`  Page size:           ${args.pageSize}`);
  console.error(`  Include geometry:    ${args.geometry}`);
  console.error(`  Resume offset:       ${offset}`);
  console.error("");

  while (offset < totalCount) {
    if (args.limitPages != null && pagesDone >= args.limitPages) {
      console.error(`Stopping at --limit-pages ${args.limitPages}`);
      break;
    }

    const page = await queryCamaParcelPage({
      resultOffset: offset,
      recordCount: args.pageSize,
      returnGeometry: args.geometry,
    });

    if (!page.length) break;

    const fullLines = [];
    const compLines = [];

    for (const row of page) {
      const parcelId = row.attributes?.PARCEL_ID ?? row.attributes?.PARCELID ?? null;
      if (!parcelId) continue;

      fullLines.push(
        JSON.stringify({
          parcel_id: parcelId,
          cama_raw: row.attributes,
        })
      );

      const comp = toCompRecord(row.attributes, row.geometry);
      if (comp) {
        compLines.push(JSON.stringify(comp));
        if (comp.sale_price != null && comp.sale_price > 0) stats.with_sale_price++;
        if (comp.sale_date) stats.with_sale_date++;
        if (comp.lat != null && comp.lon != null) stats.with_coordinates++;
        if (comp.likely_vacant_land) stats.likely_vacant_land++;
        if (comp.has_improvements) stats.has_improvements++;
      }
    }

    appendLines(FULL_JSONL, fullLines);
    appendLines(COMP_JSONL, compLines);

    pulled += page.length;
    stats.pulled = pulled;
    offset += page.length;
    pagesDone++;

    saveState({
      next_offset: offset,
      pulled,
      total_count: totalCount,
      geometry: args.geometry,
      stats,
      updated_at: new Date().toISOString(),
    });

    console.error(
      `  page ${pagesDone}/${totalPages} offset ${offset}/${totalCount} (+${page.length})`
    );

    if (args.delayMs) await new Promise((r) => setTimeout(r, args.delayMs));
  }

  const complete = offset >= totalCount;
  const manifest = {
    generated_at: new Date().toISOString(),
    source: "Parcel_CAMA/MapServer/0",
    complete,
    total_count: totalCount,
    pulled: stats.pulled,
    geometry: args.geometry,
    files: {
      cama_full: path.relative(path.join(__dirname, ".."), FULL_JSONL),
      comp_index: path.relative(path.join(__dirname, ".."), COMP_JSONL),
    },
    stats: summarizeStats(stats),
  };

  saveManifest(manifest);

  console.error("");
  console.error(complete ? "County parcel pull complete" : "County parcel pull paused");
  console.error(`  Pulled:              ${stats.pulled}/${totalCount}`);
  console.error(`  With sale price:     ${stats.with_sale_price}`);
  console.error(`  With sale date:      ${stats.with_sale_date}`);
  console.error(`  With coordinates:    ${stats.with_coordinates}`);
  console.error(`  Likely vacant land:  ${stats.likely_vacant_land}`);
  console.error(`  Has improvements:    ${stats.has_improvements}`);
  console.error("");
  console.error(`Wrote ${FULL_JSONL}`);
  console.error(`Wrote ${COMP_JSONL}`);
  console.error(`Wrote ${MANIFEST_JSON}`);
  if (!complete) console.error(`Resume: npm run pull:county-parcels`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

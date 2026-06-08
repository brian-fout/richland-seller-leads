/**
 * One-time migration: move legacy data/* into data/counties/richland/.
 *
 * Usage:
 *   node scripts/migrate-data-to-counties.mjs
 *   node scripts/migrate-data-to-counties.mjs --dry-run
 *   node scripts/migrate-data-to-counties.mjs --county richland
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { REPO_ROOT } from "../src/core/county-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_ROOT = path.join(REPO_ROOT, "data");
const RESERVED = new Set(["counties", "platform"]);

function parseArgs() {
  const countyIdx = process.argv.indexOf("--county");
  return {
    countyId: countyIdx >= 0 ? process.argv[countyIdx + 1].toLowerCase() : "richland",
    dryRun: process.argv.includes("--dry-run"),
  };
}

function main() {
  const { countyId, dryRun } = parseArgs();
  const targetRoot = path.join(LEGACY_ROOT, "counties", countyId);

  if (!fs.existsSync(LEGACY_ROOT)) {
    console.error(`Nothing to migrate — missing ${LEGACY_ROOT}`);
    process.exit(0);
  }

  const entries = fs.readdirSync(LEGACY_ROOT, { withFileTypes: true });
  const toMove = entries.filter((e) => !RESERVED.has(e.name));

  if (!toMove.length) {
    console.error("Legacy data/ is empty or already migrated.");
    process.exit(0);
  }

  if (!dryRun) {
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.mkdirSync(path.join(LEGACY_ROOT, "platform"), { recursive: true });
  }

  let moved = 0;
  let skipped = 0;

  for (const entry of toMove) {
    const src = path.join(LEGACY_ROOT, entry.name);
    const dest = path.join(targetRoot, entry.name);

    if (fs.existsSync(dest)) {
      console.error(`SKIP (exists): ${entry.name}`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.error(`DRY-RUN move: ${entry.name} → counties/${countyId}/`);
    } else {
      fs.renameSync(src, dest);
      console.error(`Moved: ${entry.name}`);
    }
    moved++;
  }

  console.error("");
  console.error(`Migration ${dryRun ? "(dry run) " : ""}complete for ${countyId}`);
  console.error(`  Moved:   ${moved}`);
  console.error(`  Skipped: ${skipped}`);
  console.error(`  Target:  ${targetRoot}`);
  if (!dryRun) {
    console.error("");
    console.error("Verify:");
    console.error("  npm run query:leads -- --county richland --limit 5");
    console.error("  npm run test:arv");
  }
}

main();

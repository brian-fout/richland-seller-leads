/**
 * Review owner-change stale candidates before bulk dismiss.
 *
 * Usage:
 *   npm run review:stale-leads
 *   npm run review:stale-leads -- --format json
 *   npm run review:stale-leads -- --limit 20
 */

import fs from "fs";
import { getActiveCounty } from "../src/core/county-context.mjs";
import { countyPaths } from "../src/core/county-paths.mjs";

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit");
  const countyIdx = process.argv.indexOf("--county");
  return {
    county: countyIdx >= 0 ? process.argv[countyIdx + 1].toLowerCase() : getActiveCounty(),
    limit: limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : 50,
    format: process.argv.includes("--format") ? process.argv[process.argv.indexOf("--format") + 1] : "table",
  };
}

function formatTable(rows) {
  const headers = ["parcel_id", "city", "address", "sources", "previous_owner", "current_owner"];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    lines.push(
      [
        r.parcel_id ?? "",
        r.city ?? "",
        r.address ?? "",
        (r.sources ?? []).join("+"),
        r.previous_owner ?? "",
        r.current_owner ?? "",
      ].join("\t")
    );
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs();
  const p = countyPaths(args.county);
  if (!fs.existsSync(p.leadStaleCandidates)) {
    console.error(`No stale candidates. Run: npm run build:lead-cards`);
    process.exit(1);
  }

  const file = JSON.parse(fs.readFileSync(p.leadStaleCandidates, "utf8"));
  let candidates = file.candidates ?? [];
  if (args.limit > 0) candidates = candidates.slice(0, args.limit);

  if (args.format === "json") {
    console.log(JSON.stringify({ ...file, candidates, showing: candidates.length }, null, 2));
    return;
  }

  console.error(`Stale owner candidates — ${args.county} (${file.count ?? candidates.length} total, showing ${candidates.length})`);
  console.error("Likely owner turnover after OWNDATMAX parser fix — review before dismiss.\n");
  console.log(formatTable(candidates));
  console.error("\nDismiss one:  npm run dismiss:lead -- --parcel ID --reason owner_changed");
  console.error("Dismiss all:  npm run dismiss:lead -- --dismiss-stale");
}

main();

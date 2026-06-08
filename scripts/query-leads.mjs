/**
 * @shared Query ranked leads — one county, one city, or all counties.
 *
 * Usage:
 *   npm run query:leads -- --county richland --limit 5
 *   npm run query:leads -- --county richland --city Mansfield --limit 5
 *   npm run query:leads -- --needs-review --city Mansfield --limit 20
 *   npm run query:leads -- --offer-ready --city Mansfield
 *   npm run query:leads -- --format csv --export agent-review.csv
 *   npm run export:agent-review -- --city Mansfield
 */

import fs from "fs";
import path from "path";
import { getActiveCounty, paths } from "../src/core/county-context.mjs";
import {
  agentReviewRow,
  listActiveCounties,
  loadAllLeadCards,
  slimLeadRow,
} from "../src/core/platform-leads.mjs";

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit");
  const cityIdx = process.argv.indexOf("--city");
  const countiesIdx = process.argv.indexOf("--counties");
  const countyIdx = process.argv.indexOf("--county");
  const formatIdx = process.argv.indexOf("--format");
  const exportIdx = process.argv.indexOf("--export");

  const allCounties = process.argv.includes("--all-counties");
  let counties = null;

  if (countiesIdx >= 0 && process.argv[countiesIdx + 1]) {
    counties = process.argv[countiesIdx + 1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else if (countyIdx >= 0 && process.argv[countyIdx + 1]) {
    counties = [process.argv[countyIdx + 1].toLowerCase()];
  } else if (allCounties) {
    counties = listActiveCounties();
  } else {
    counties = [getActiveCounty()];
  }

  let exportPath = null;
  if (exportIdx >= 0) {
    const val = process.argv[exportIdx + 1];
    exportPath = val && !val.startsWith("--") ? val : null;
  }

  return {
    counties,
    city: cityIdx >= 0 ? process.argv[cityIdx + 1] : null,
    limit: limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : 10,
    format: formatIdx >= 0 ? process.argv[formatIdx + 1] : "table",
    listCounties: process.argv.includes("--list-counties"),
    includeDismissed: process.argv.includes("--include-dismissed"),
    needsReview: process.argv.includes("--needs-review"),
    offerReady: process.argv.includes("--offer-ready"),
    exportPath,
  };
}

function escapeCsv(value) {
  const s = value == null ? "" : String(value);
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatCsv(rows, headers) {
  const keys = headers ?? (rows.length ? Object.keys(rows[0]) : []);
  const lines = [keys.join(",")];
  for (const row of rows) {
    lines.push(keys.map((k) => escapeCsv(row[k])).join(","));
  }
  return lines.join("\n");
}

function formatTable(rows) {
  const headers = [
    "rank",
    "county",
    "city",
    "address",
    "parcel_id",
    "sources",
    "score",
    "effective_arv",
    "model_arv",
    "agent_arv",
    "agent_offer",
    "agent_verdict",
    "offer_ready",
    "contact",
  ];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    lines.push(
      [
        r.rank ?? "",
        r.county_id ?? "",
        r.city ?? "",
        r.address ?? "",
        r.parcel_id ?? "",
        (r.sources ?? []).join("+"),
        r.rank_score ?? "",
        r.effective_arv ?? "",
        r.arv_most_likely ?? "",
        r.agent_arv ?? "",
        r.agent_offer_max ?? "",
        r.agent_verdict ?? "",
        r.offer_ready ? "yes" : r.needs_agent_review ? "review" : "no",
        r.safe_to_contact ? "yes" : "no",
      ].join("\t")
    );
  }
  return lines.join("\n");
}

function defaultExportPath(counties) {
  const county = counties[0] ?? getActiveCounty();
  return path.join(paths(county).dataRoot, "agent-review-queue.csv");
}

function main() {
  const args = parseArgs();

  if (args.listCounties) {
    const active = listActiveCounties();
    console.log(JSON.stringify({ active_counties: active }, null, 2));
    return;
  }

  if (!args.counties.length) {
    console.error("No counties with lead-cards.json found.");
    console.error("Run: npm run richland:build:lead-cards  (or migrate data first)");
    process.exit(1);
  }

  const useAgentExport = args.needsReview || args.exportPath != null || args.format === "csv";
  const result = loadAllLeadCards({
    counties: args.counties,
    city: args.city,
    limit: args.exportPath ? null : args.limit,
    includeDismissed: args.includeDismissed,
    needsReview: args.needsReview,
    offerReady: args.offerReady,
  });

  const rows = result.cards.map(useAgentExport ? agentReviewRow : slimLeadRow);
  const limitedRows = args.exportPath ? rows.slice(0, args.limit > 0 ? args.limit : rows.length) : rows;

  if (args.exportPath || (args.format === "csv" && args.needsReview)) {
    const outPath = path.resolve(args.exportPath ?? defaultExportPath(args.counties));
    const csv = formatCsv(limitedRows);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${csv}\n`);
    console.error(`Wrote ${limitedRows.length} rows → ${outPath}`);
    return;
  }

  if (args.format === "csv") {
    console.log(formatCsv(limitedRows));
    return;
  }

  if (args.format === "json") {
    console.log(
      JSON.stringify(
        {
          query: {
            counties: args.counties,
            city: args.city ?? null,
            limit: args.limit,
            needs_review: args.needsReview,
            offer_ready: args.offerReady,
          },
          sources: result.sources,
          total_before_limit: result.total_before_limit,
          rows: limitedRows,
        },
        null,
        2
      )
    );
    return;
  }

  const scope =
    args.city != null
      ? `${args.counties.join(",")} / ${args.city}`
      : args.counties.length > 1
        ? `all counties (${args.counties.join(", ")})`
        : args.counties[0];

  const filterNote = args.needsReview
    ? ", needs_agent_review"
    : args.offerReady
      ? ", offer_ready"
      : "";
  const dismissedNote =
    result.dismissed_excluded > 0 ? `, ${result.dismissed_excluded} dismissed excluded` : "";
  console.error(
    `Top ${limitedRows.length} leads — ${scope} (${result.total_before_limit} matched${filterNote}${dismissedNote})\n`
  );
  console.log(formatTable(limitedRows));
}

main();

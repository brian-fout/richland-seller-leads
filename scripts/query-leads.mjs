/**
 * @shared Query ranked leads — one county, one city, or all counties.
 *
 * Usage:
 *   npm run query:leads -- --county richland --limit 5
 *   npm run query:leads -- --county richland --city Mansfield --limit 5
 *   npm run query:leads -- --all-counties --limit 5
 *   npm run query:leads -- --counties richland,franklin --format table
 */

import { getActiveCounty } from "../src/core/county-context.mjs";
import { listActiveCounties, loadAllLeadCards, slimLeadRow } from "../src/core/platform-leads.mjs";

function parseArgs() {
  const limitIdx = process.argv.indexOf("--limit");
  const cityIdx = process.argv.indexOf("--city");
  const countiesIdx = process.argv.indexOf("--counties");
  const countyIdx = process.argv.indexOf("--county");
  const formatIdx = process.argv.indexOf("--format");

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

  return {
    counties,
    city: cityIdx >= 0 ? process.argv[cityIdx + 1] : null,
    limit: limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : 10,
    format: formatIdx >= 0 ? process.argv[formatIdx + 1] : "table",
    listCounties: process.argv.includes("--list-counties"),
    includeDismissed: process.argv.includes("--include-dismissed"),
  };
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
    "arv",
    "agent_arv",
    "agent_verdict",
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
        r.arv_most_likely ?? "",
        r.agent_arv ?? "",
        r.agent_verdict ?? "",
        r.safe_to_contact ? "yes" : "no",
      ].join("\t")
    );
  }
  return lines.join("\n");
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

  const result = loadAllLeadCards({
    counties: args.counties,
    city: args.city,
    limit: args.limit,
    includeDismissed: args.includeDismissed,
  });

  const rows = result.cards.map(slimLeadRow);

  if (args.format === "json") {
    console.log(
      JSON.stringify(
        {
          query: {
            counties: args.counties,
            city: args.city ?? null,
            limit: args.limit,
          },
          sources: result.sources,
          total_before_limit: result.total_before_limit,
          rows,
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

  const dismissedNote =
    result.dismissed_excluded > 0 ? `, ${result.dismissed_excluded} dismissed excluded` : "";
  console.error(
    `Top ${rows.length} leads — ${scope} (${result.total_before_limit} matched${dismissedNote})\n`
  );
  console.log(formatTable(rows));
}

main();

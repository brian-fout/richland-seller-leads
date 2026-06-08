/**
 * @shared Dismiss or restore leads (persists across build-lead-cards rebuilds).
 *
 * Usage:
 *   npm run dismiss:lead -- --parcel 027-04-044-07-000 --reason owner_changed
 *   npm run dismiss:lead -- --parcel 027-04-044-07-000 --reason sold --notes "Quit claim 2026-04"
 *   npm run dismiss:lead -- --list
 *   npm run dismiss:lead -- --stale              # list owner-change candidates
 *   npm run dismiss:lead -- --dismiss-stale      # dismiss all stale candidates
 *   npm run dismiss:lead -- --undismiss --parcel 027-04-044-07-000
 *
 * Dismissed leads auto-reinstate on build:lead-cards when a new distress list
 * record appears (new source or new filing on an existing source).
 */

import fs from "fs";
import { getActiveCounty } from "../src/core/county-context.mjs";
import { countyPaths } from "../src/core/county-paths.mjs";
import {
  DISMISS_REASONS,
  dismissParcel,
  loadSuppressions,
  saveSuppressions,
  undismissParcel,
} from "../src/core/lead-suppressions.mjs";
import { buildAllClusters } from "./link-leads.mjs";

function parseArgs() {
  const parcelIdx = process.argv.indexOf("--parcel");
  const reasonIdx = process.argv.indexOf("--reason");
  const notesIdx = process.argv.indexOf("--notes");
  const countyIdx = process.argv.indexOf("--county");

  return {
    county: countyIdx >= 0 ? process.argv[countyIdx + 1].toLowerCase() : getActiveCounty(),
    parcel: parcelIdx >= 0 ? process.argv[parcelIdx + 1] : null,
    reason: reasonIdx >= 0 ? process.argv[reasonIdx + 1] : "other",
    notes: notesIdx >= 0 ? process.argv[notesIdx + 1] : null,
    list: process.argv.includes("--list"),
    stale: process.argv.includes("--stale"),
    dismissStale: process.argv.includes("--dismiss-stale"),
    undismiss: process.argv.includes("--undismiss"),
  };
}

function loadStaleCandidates(filePath) {
  if (!fs.existsSync(filePath)) return { generated_at: null, candidates: [] };
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clusterForParcel(parcelId) {
  const { allClusters } = buildAllClusters();
  return allClusters.find((c) => c.parcel_id === parcelId) ?? null;
}

function main() {
  const args = parseArgs();
  const p = countyPaths(args.county);
  const suppressions = loadSuppressions(p.leadSuppressions);

  if (args.stale || args.dismissStale) {
    const staleFile = loadStaleCandidates(p.leadStaleCandidates);
    const candidates = staleFile.candidates ?? [];

    if (args.stale) {
      console.log(
        JSON.stringify(
          {
            county_id: args.county,
            generated_at: staleFile.generated_at ?? null,
            count: candidates.length,
            candidates,
          },
          null,
          2
        )
      );
      return;
    }

    if (!candidates.length) {
      console.error("No stale owner-change candidates. Run: npm run build:lead-cards");
      return;
    }

    for (const c of candidates) {
      dismissParcel(suppressions, {
        parcel_id: c.parcel_id,
        reason: c.suggested_reason ?? "owner_changed",
        notes: `Auto: ${c.previous_owner} → ${c.current_owner}`,
        owner_at_dismiss: c.current_owner,
        source: "stale_owner_detected",
        cluster: clusterForParcel(c.parcel_id),
      });
    }
    saveSuppressions(p.leadSuppressions, suppressions);
    console.error(`Dismissed ${candidates.length} stale lead(s) → ${p.leadSuppressions}`);
    console.error("Rebuild cards: npm run build:lead-cards");
    return;
  }

  if (args.list) {
    const rows = [...suppressions.values()].sort((a, b) =>
      String(a.parcel_id).localeCompare(String(b.parcel_id))
    );
    console.log(
      JSON.stringify(
        {
          county_id: args.county,
          file: p.leadSuppressions,
          count: rows.length,
          reasons: DISMISS_REASONS,
          suppressions: rows,
        },
        null,
        2
      )
    );
    return;
  }

  if (!args.parcel) {
    console.error("Provide --parcel ID, or use --list / --stale / --dismiss-stale");
    process.exit(1);
  }

  if (args.undismiss) {
    if (!suppressions.has(args.parcel)) {
      console.error(`Not suppressed: ${args.parcel}`);
      process.exit(1);
    }
    undismissParcel(suppressions, args.parcel);
    saveSuppressions(p.leadSuppressions, suppressions);
    console.error(`Restored ${args.parcel} — will reappear on next build:lead-cards`);
    return;
  }

  const rec = dismissParcel(suppressions, {
    parcel_id: args.parcel,
    reason: args.reason,
    notes: args.notes,
    source: "manual",
    cluster: clusterForParcel(args.parcel),
  });
  saveSuppressions(p.leadSuppressions, suppressions);
  console.error(`Dismissed ${args.parcel} (${rec.reason})`);
  console.error(`  File: ${p.leadSuppressions}`);
  console.error("Rebuild cards to drop from lead-cards.json: npm run build:lead-cards");
}

main();

/**
 * Record free-form agent feedback to improve ARV calibration and lead ranking.
 * Format does not matter — paste texts, emails, or voice transcripts.
 *
 * Usage:
 *   npm run agent:feedback -- --parcel 027-04-044-07-000 --text "ARV around 58k, rehab 18-22k, pass for now"
 *   npm run agent:feedback -- --text "Bowman st retail 60-65k after full rehab"
 *   npm run agent:feedback -- --file agent-notes.txt
 *   echo "agent says 62k arv" | npm run agent:feedback -- --paste
 *   npm run agent:feedback -- --list
 *   npm run agent:feedback -- --show 027-04-044-07-000
 *
 * In Cursor chat: paste agent notes and ask to record — or run this CLI.
 */

import fs from "fs";
import readline from "readline";
import { getActiveCounty } from "../src/core/county-context.mjs";
import { countyPaths } from "../src/core/county-paths.mjs";
import {
  compareAgentToModel,
  getAgentCalibrationForParcel,
  loadAgentCalibration,
  loadAgentFeedback,
  parseFreeformFeedback,
  recordFeedback,
} from "../src/core/agent-feedback.mjs";
import { computeEffectiveArv } from "../src/core/effective-arv.mjs";
import { loadCountyLeadCards } from "../src/core/platform-leads.mjs";

function parseArgs() {
  const textIdx = process.argv.indexOf("--text");
  const fileIdx = process.argv.indexOf("--file");
  const parcelIdx = process.argv.indexOf("--parcel");
  const countyIdx = process.argv.indexOf("--county");
  const byIdx = process.argv.indexOf("--by");

  return {
    county: countyIdx >= 0 ? process.argv[countyIdx + 1].toLowerCase() : getActiveCounty(),
    parcel: parcelIdx >= 0 ? process.argv[parcelIdx + 1] : null,
    text: textIdx >= 0 ? process.argv[textIdx + 1] : null,
    file: fileIdx >= 0 ? process.argv[fileIdx + 1] : null,
    submittedBy: byIdx >= 0 ? process.argv[byIdx + 1] : "agent",
    paste: process.argv.includes("--paste"),
    list: process.argv.includes("--list"),
    show: process.argv.includes("--show") ? process.argv[process.argv.indexOf("--show") + 1] : null,
    dryRun: process.argv.includes("--dry-run"),
  };
}

async function readStdin() {
  if (process.stdin.isTTY) {
    console.error("Paste agent feedback, then Ctrl+Z Enter (Windows) or Ctrl+D (Unix):");
  }
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines.join("\n").trim();
}

async function loadRawText(args) {
  if (args.text) return args.text;
  if (args.file) {
    if (!fs.existsSync(args.file)) throw new Error(`File not found: ${args.file}`);
    return fs.readFileSync(args.file, "utf8").trim();
  }
  if (args.paste || !process.stdin.isTTY) return readStdin();
  return null;
}

function formatShow(parcelId, calibration, feedbackPath, countyId) {
  const agent = getAgentCalibrationForParcel(calibration, parcelId);
  const history = loadAgentFeedback(feedbackPath).filter(
    (e) => e.parcel_id === parcelId || e.parsed?.parcel_ids?.includes(parcelId)
  );
  const card = loadCountyLeadCards(countyId).cards.find((c) => c.parcel_id === parcelId) ?? null;
  const modelArv = card?.arv?.most_likely_arv ?? card?.arv?.mid ?? null;
  const layer = card ? computeEffectiveArv(card) : computeEffectiveArv({ agent_calibration: agent, arv: card?.arv });

  console.log(
    JSON.stringify(
      {
        parcel_id: parcelId,
        calibration: agent,
        model_arv: modelArv,
        agent_model_compare: compareAgentToModel(agent, modelArv),
        effective_arv_layer: layer,
        history_count: history.length,
        history: history.slice(-5),
      },
      null,
      2
    )
  );
}

async function main() {
  const args = parseArgs();
  const p = countyPaths(args.county);
  const feedbackPath = p.agentFeedback;
  const calibrationPath = p.agentCalibration;

  if (args.list) {
    const calibration = loadAgentCalibration(calibrationPath);
    console.log(
      JSON.stringify(
        {
          county_id: args.county,
          file: feedbackPath,
          calibration_file: calibrationPath,
          parcel_count: calibration.parcel_count,
          parcels: calibration.parcels,
        },
        null,
        2
      )
    );
    return;
  }

  if (args.show) {
    formatShow(args.show, loadAgentCalibration(calibrationPath), feedbackPath, args.county);
    return;
  }

  const raw_text = await loadRawText(args);
  if (!raw_text) {
    console.error("Provide --text, --file path, or --paste (stdin).");
    console.error("Examples:");
    console.error('  npm run agent:feedback -- --parcel 027-04-044-07-000 --text "ARV ~58k"');
    console.error("  npm run agent:feedback -- --file notes-from-agent.txt");
    process.exit(1);
  }

  const parsed = parseFreeformFeedback(raw_text, { parcel_id: args.parcel });

  if (args.dryRun) {
    console.log(JSON.stringify({ parcel_id: args.parcel, raw_text, parsed }, null, 2));
    return;
  }

  const entry = recordFeedback(feedbackPath, calibrationPath, {
    raw_text,
    parcel_id: args.parcel,
    source: "agent",
    submitted_by: args.submittedBy,
  });

  console.error("Agent feedback recorded");
  console.error(`  ID:      ${entry.id}`);
  console.error(`  Parcel:  ${entry.parcel_id ?? "(none detected — add --parcel)"}`);
  console.error(`  Parsed:  ${JSON.stringify(entry.parsed)}`);
  console.error(`  File:    ${feedbackPath}`);
  console.error(`  Calib:   ${calibrationPath}`);

  if (!entry.parcel_id) {
    console.error("");
    console.error("  Tip: re-run with --parcel if ID was not in the text.");
  }

  console.log(JSON.stringify(entry, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

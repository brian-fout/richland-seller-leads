/**
 * Wait for an in-flight lead Beacon batch, then run county-wide enrichment.
 * Rare / high IP-ban risk — requires --confirm-bulk (see enrich-from-beacon.mjs policy).
 *
 * Usage:
 *   node scripts/beacon-wait-then-county.mjs --confirm-bulk
 *   node scripts/beacon-wait-then-county.mjs --pid 67196 --confirm-bulk
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function parsePidArg() {
  const idx = process.argv.indexOf("--pid");
  if (idx >= 0) {
    const pid = parseInt(process.argv[idx + 1], 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leadBatchLooksComplete() {
  const markers = [
    path.join(DATA_DIR, "beacon-enrich-leads-progress.jsonl"),
    path.join(DATA_DIR, "beacon-enrich-progress.jsonl"),
  ];
  for (const file of markers) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (!lines.length) continue;
    const last = JSON.parse(lines[lines.length - 1]);
    if (last.total === 3303 && last.index >= 3303) return true;
  }
  return false;
}

async function waitForLeadBatch(pid) {
  console.error("Waiting for lead Beacon batch to finish...");
  if (pid) console.error(`  Watching PID: ${pid}`);

  while (true) {
    const alive = pid ? processAlive(pid) : true;
    const progressDone = leadBatchLooksComplete();

    if (pid && !alive) {
      console.error("  Lead batch process exited.");
      return;
    }
    if (!pid && progressDone) {
      console.error("  Lead progress reached 3303/3303.");
      return;
    }
    if (pid && progressDone) {
      console.error("  Lead progress complete; waiting for process exit...");
      await sleep(5000);
      if (!processAlive(pid)) return;
    }

    await sleep(30000);
  }
}

function runCountyBatch() {
  const script = path.join(__dirname, "enrich-from-beacon.mjs");
  const args = [script, "--county", "--headed", "--apply", "--delay-ms", "3000", "--confirm-bulk"];

  console.error("");
  console.error("Launching county-wide Beacon enrichment (71,716 parcels)...");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`County batch exited with code ${code}`));
    });
  });
}

async function main() {
  if (!process.argv.includes("--confirm-bulk")) {
    console.error("Blocked: county-wide Beacon requires --confirm-bulk (IP-ban risk).");
    console.error("  Prefer CAMA bulk. Spot-check: npm run enrich:beacon -- --parcel ID --headed --delay-ms 3000");
    process.exit(1);
  }
  const pid = parsePidArg();
  await waitForLeadBatch(pid);
  await sleep(3000);
  await runCountyBatch();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Refresh parcel owner/values from Richland Beacon (more current than Parcel_CAMA GIS).
 *
 * POLICY: Use very sparingly — headed spot-checks only. ARV/comps use CAMA, not Beacon.
 * Bulk county runs require --confirm-bulk (high IP-ban risk).
 *
 * Usage:
 *   npm run beacon:session                    # once, pass Cloudflare
 *   npm run enrich:beacon -- --parcel 027-04-044-07-000
 *   npm run enrich:beacon -- --limit 50
 *   npm run enrich:beacon -- --lead-cards    # distress lead parcels only
 *   npm run enrich:beacon -- --county         # all county comp-index parcels
 *   npm run enrich:beacon -- --apply         # merge into comp-index-beacon.jsonl
 *   npm run enrich:beacon -- --lead-cards --then-county --apply
 *   npm run enrich:beacon -- --parcel 027-04-044-07-000 --delay-ms 3000 --jitter-pct 50
 *   npm run enrich:beacon -- --limit 10 --no-jitter --delay-ms 1200
 *   npm run enrich:beacon -- --county --confirm-bulk   # rare; IP-ban risk
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths } from "../src/core/county-context.mjs";
import {
  BEACON_CACHE_PATH,
  COMP_INDEX_PATH,
  createBeaconBrowser,
  loadBeaconCache,
  saveBeaconCache,
  applyBeaconToCompIndex,
} from "./beacon-enrich-lib.mjs";
import {
  warmBeaconSession,
  fetchBeaconParcel as fetchBeaconParcelOnce,
  isCloudflarePage,
  isBeaconIpBanned,
  waitForCloudflareCleared,
} from "./beacon-parcel.mjs";

const IP_BAN_MESSAGE = `
Beacon blocked this IP for automated access.
  Email: support@schneidergis.com
  Ask about bulk parcel/owner data export for Richland County OH.
  Do not resume batch scraping until access is restored.
`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = paths();

const DEFAULT_DELAY_MS = 1200;
const DEFAULT_JITTER_PCT = 40;
/** Above this many fetches without --confirm-bulk, refuse to run (spot-check only). */
const SPOT_CHECK_MAX = 25;

const BEACON_SPARING_REMINDER = `
Beacon = occasional spot-checks only (this IP was banned before).
  ARV / comps / lead cards: CAMA bulk — npm run batch:arv, richland:import:cama
  Good:  --parcel ONE --headed --delay-ms 3000
  Bad:   --county, --then-county (needs --confirm-bulk; prefer support@schneidergis.com export)
`;

function parseArgs() {
  const parcelIdx = process.argv.indexOf("--parcel");
  const limitIdx = process.argv.indexOf("--limit");
  const delayIdx = process.argv.indexOf("--delay-ms");
  const jitterIdx = process.argv.indexOf("--jitter-pct");
  const parcel = parcelIdx >= 0 ? process.argv[parcelIdx + 1] : null;
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : null;
  const delayMs = delayIdx >= 0 ? parseInt(process.argv[delayIdx + 1], 10) : DEFAULT_DELAY_MS;
  const jitterPct = jitterIdx >= 0 ? parseInt(process.argv[jitterIdx + 1], 10) : DEFAULT_JITTER_PCT;
  const noJitter = process.argv.includes("--no-jitter");
  return {
    parcel,
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : DEFAULT_DELAY_MS,
    jitterPct: noJitter
      ? 0
      : Number.isFinite(jitterPct) && jitterPct >= 0
        ? Math.min(jitterPct, 100)
        : DEFAULT_JITTER_PCT,
    noJitter,
    leadCards: process.argv.includes("--lead-cards"),
    county: process.argv.includes("--county"),
    thenCounty: process.argv.includes("--then-county"),
    apply: process.argv.includes("--apply"),
    headed: process.argv.includes("--headed") || process.argv.includes("--interactive"),
    force: process.argv.includes("--force"),
    confirmBulk: process.argv.includes("--confirm-bulk"),
  };
}

function printBeaconSparingReminder() {
  console.error(BEACON_SPARING_REMINDER);
}

function assertBeaconUseAllowed(args, { pendingCount, parcelCount }) {
  printBeaconSparingReminder();

  if (args.county || args.thenCounty) {
    if (!args.confirmBulk) {
      console.error("Blocked: --county / --then-county require --confirm-bulk.");
      console.error("  Use auditor CAMA for bulk owner/parcel data instead.");
      process.exit(1);
    }
    console.error("WARNING: County-wide Beacon — high IP-ban risk. Prefer CAMA bulk export.");
  }

  if (pendingCount > SPOT_CHECK_MAX && !args.confirmBulk) {
    console.error(
      `Blocked: ${pendingCount} parcels to fetch (max ${SPOT_CHECK_MAX} without --confirm-bulk).`
    );
    console.error("  Spot-check: --parcel ID  or  --limit 10  --headed  --delay-ms 3000");
    process.exit(1);
  }

  if (pendingCount > 10 && pendingCount <= SPOT_CHECK_MAX) {
    console.error(
      `Reminder: fetching ${pendingCount}/${parcelCount} parcels — keep Beacon rare; CAMA covers most needs.`
    );
  }
}

/** Uniform random sleep: baseMs ± jitterPct (40 => 0.6x–1.4x base). */
function delayRangeMs(baseMs, jitterPct) {
  if (!baseMs || baseMs <= 0 || !jitterPct) return { min: baseMs, max: baseMs };
  const pct = jitterPct / 100;
  return {
    min: Math.max(0, Math.round(baseMs * (1 - pct))),
    max: Math.round(baseMs * (1 + pct)),
  };
}

function sleepWithJitter(baseMs, jitterPct) {
  if (!baseMs || baseMs <= 0) return Promise.resolve();
  const { min, max } = delayRangeMs(baseMs, jitterPct);
  const ms = min === max ? min : min + Math.floor(Math.random() * (max - min + 1));
  return new Promise((r) => setTimeout(r, ms));
}

function formatDelayLabel(args) {
  if (!args.delayMs) return "none";
  if (!args.jitterPct) return `${args.delayMs}ms (fixed)`;
  const { min, max } = delayRangeMs(args.delayMs, args.jitterPct);
  return `${args.delayMs}ms ±${args.jitterPct}% (${min}–${max}ms)`;
}

function loadCountyParcelIds() {
  if (!fs.existsSync(COMP_INDEX_PATH)) {
    throw new Error(`Missing ${COMP_INDEX_PATH}. Run: npm run pull:county-parcels`);
  }
  const ids = new Set();
  for (const line of fs.readFileSync(COMP_INDEX_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const parcelId = JSON.parse(line).parcel_id;
    if (parcelId) ids.add(parcelId);
  }
  return [...ids].sort();
}

function loadParcelIds(args) {
  if (args.parcel) return [args.parcel];

  const ids = new Set();
  if (args.county) {
    return loadCountyParcelIds();
  }
  if (args.leadCards) {
    const cards = JSON.parse(fs.readFileSync(p.leadCards, "utf8"));
    for (const card of cards.cards ?? []) ids.add(card.parcel_id);
  } else {
    const index = JSON.parse(fs.readFileSync(p.leadParcelIndex, "utf8"));
    for (const p of index.parcels ?? []) ids.add(p.parcel_id);
  }

  let list = [...ids].filter(Boolean);
  if (args.limit) list = list.slice(0, args.limit);
  return list;
}

function progressPathFor(args) {
  if (args.county) return p.file("beacon-enrich-county-progress.jsonl");
  if (args.leadCards) return p.file("beacon-enrich-leads-progress.jsonl");
  return p.file("beacon-enrich-progress.jsonl");
}

function phaseLabel(args) {
  if (args.county) return "county";
  if (args.leadCards) return "lead-cards";
  return "custom";
}

async function fetchWithCloudflareRetry(page, parcelId, args) {
  while (true) {
    const result = await fetchBeaconParcelOnce(page, parcelId, {
      acceptDisclaimer: false,
      direct: true,
      waitMs: 1500,
      headed: args.headed,
    });

    if (result.status === "ok") return result;

    const challenged = await isCloudflarePage(page);
    const needsChallengeWait =
      args.headed && (challenged || result.status === "blocked" || result.status === "parse_failed");

    if (needsChallengeWait && challenged) {
      console.error(`  ${parcelId} — Cloudflare/CAPTCHA detected, batch paused...`);
      await waitForCloudflareCleared(page, { headed: true });
      continue;
    }

    return result;
  }
}

function pruneFailedCache(cache) {
  let removed = 0;
  for (const [key, value] of cache.entries()) {
    if (value?.status && value.status !== "ok") {
      cache.delete(key);
      removed++;
    }
  }
  if (removed) saveBeaconCache(cache);
  return removed;
}

async function runEnrichment(args) {
  const cache = loadBeaconCache();
  const pruned = pruneFailedCache(cache);
  if (pruned) console.error(`  Pruned ${pruned} failed cache entries (will retry)`);
  const parcelIds = loadParcelIds(args);
  const progressPath = progressPathFor(args);
  const sessionPath = p.beaconSession;
  const pending = parcelIds.filter((id) => args.force || !cache.has(id));
  const cached = parcelIds.length - pending.length;

  assertBeaconUseAllowed(args, { pendingCount: pending.length, parcelCount: parcelIds.length });

  console.error("Beacon parcel enrichment");
  console.error(`  Phase:       ${phaseLabel(args)}`);
  console.error(`  Parcels:     ${parcelIds.length}`);
  console.error(`  Headed:      ${args.headed}`);
  console.error(`  Apply merge: ${args.apply}`);
  console.error(`  Cached:      ${cached}`);
  console.error(`  To fetch:    ${pending.length}`);
  console.error(`  Delay:       ${formatDelayLabel(args)}`);
  console.error(`  Progress:    ${progressPath}`);
  console.error("");

  const { browser, context, page } = await createBeaconBrowser({ headed: args.headed });
  let fetched = 0;
  let ok = 0;
  let failed = 0;
  let sessionWarmed = false;

  try {
    for (let i = 0; i < parcelIds.length; i++) {
      const parcelId = parcelIds[i];
      const cacheKey = parcelId;
      if (!args.force && cache.has(cacheKey)) {
        if ((i + 1) % 250 === 0 || i === 0) {
          console.error(`  ${i + 1}/${parcelIds.length} ${parcelId} cached`);
        }
        continue;
      }

      if (!sessionWarmed) {
        console.error("  Warming Beacon session (complete Cloudflare/disclaimer if prompted)...");
        await warmBeaconSession(page, { headed: args.headed });
        if (await isBeaconIpBanned(page)) {
          console.error(IP_BAN_MESSAGE);
          break;
        }
        sessionWarmed = true;
      }

      const result = await fetchWithCloudflareRetry(page, parcelId, args);

      if (result.error === "ip_banned" || (await isBeaconIpBanned(page))) {
        console.error(IP_BAN_MESSAGE);
        break;
      }

      if (result.status === "ok") {
        cache.set(cacheKey, result);
        saveBeaconCache(cache);
      }
      fetched++;

      const progress = {
        phase: phaseLabel(args),
        at: new Date().toISOString(),
        index: i + 1,
        total: parcelIds.length,
        parcel_id: parcelId,
        status: result.status,
        owner_name: result.owner_name ?? null,
        error: result.error ?? null,
      };
      fs.appendFileSync(progressPath, `${JSON.stringify(progress)}\n`);

      if (result.status === "ok") {
        ok++;
        if (fetched % 10 === 0 || fetched <= 3) {
          console.error(
            `  ${i + 1}/${parcelIds.length} ${parcelId} ok owner=${result.owner_name ?? "?"}`
          );
        }
      } else {
        failed++;
        console.error(
          `  ${i + 1}/${parcelIds.length} ${parcelId} ${result.status} ${result.error ?? ""} (not cached — will retry on re-run)`
        );
        if (result.status === "blocked" && !args.headed) {
          console.error("  Cloudflare block — re-run with --headed and complete verification in browser.");
        }
      }

      if (fetched % 25 === 0) {
        const state = await context.storageState();
        fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
      }

      if (args.delayMs) await sleepWithJitter(args.delayMs, args.jitterPct);
    }

    const state = await context.storageState();
    fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  } finally {
    await browser.close();
  }

  if (args.apply) {
    const { written, updated } = applyBeaconToCompIndex(cache);
    console.error("");
    console.error(`Applied beacon overlay: ${updated} updated -> ${written}`);
  }

  if (args.apply && args.leadCards) {
    const { spawnSync } = await import("child_process");
    const cardsScript = path.join(__dirname, "build-lead-cards.mjs");
    console.error("");
    console.error("Rebuilding lead cards with beacon overlay...");
    const result = spawnSync(process.execPath, [cardsScript], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  console.error("");
  console.error(`Beacon enrichment complete (${phaseLabel(args)})`);
  console.error(`  Fetched: ${fetched}, ok: ${ok}, failed: ${failed}`);
  console.error(`  Cache:   ${BEACON_CACHE_PATH}`);

  return { fetched, ok, failed };
}

async function main() {
  const args = parseArgs();
  if (args.leadCards && args.county) {
    console.error("Use --lead-cards or --county, not both.");
    process.exit(1);
  }

  await runEnrichment(args);

  if (args.thenCounty && args.leadCards) {
    console.error("");
    console.error("Starting county-wide Beacon enrichment...");
    await runEnrichment({
      ...args,
      leadCards: false,
      county: true,
      thenCounty: false,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

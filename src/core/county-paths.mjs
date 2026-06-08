/**
 * County-aware data paths. Canonical layout: data/counties/{countyId}/
 * Falls back to data/ (legacy Richland layout) when county folder is not in use.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, "..", "..");

export const DEFAULT_COUNTY = "richland";

export function parseCountyArg(argv = process.argv) {
  const idx = argv.indexOf("--county");
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]).toLowerCase();
  return DEFAULT_COUNTY;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Prefer county-scoped path; fall back to legacy flat data/ for Richland. */
function resolvePath(countyRoot, legacyRoot, relative) {
  const countyPath = path.join(countyRoot, relative);
  const legacyPath = path.join(legacyRoot, relative);
  if (exists(countyPath)) return countyPath;
  if (exists(legacyPath)) return legacyPath;
  return countyPath;
}

function resolveDir(countyRoot, legacyRoot, relative) {
  const countyPath = path.join(countyRoot, relative);
  const legacyPath = path.join(legacyRoot, relative);
  if (exists(countyPath)) return countyPath;
  if (exists(legacyPath)) return legacyPath;
  return countyPath;
}

/**
 * @param {string} [countyId]
 * @returns {import('./county-paths.mjs').CountyPaths}
 */
export function countyPaths(countyId = DEFAULT_COUNTY) {
  const countyRoot = path.join(REPO_ROOT, "data", "counties", countyId);
  const legacyRoot = path.join(REPO_ROOT, "data");

  const dataRoot =
    countyId === DEFAULT_COUNTY &&
    !exists(path.join(countyRoot, "lead-cards.json")) &&
    exists(path.join(legacyRoot, "lead-cards.json"))
      ? legacyRoot
      : exists(countyRoot) || countyId !== DEFAULT_COUNTY
        ? countyRoot
        : legacyRoot;

  const countyParcels = resolveDir(countyRoot, legacyRoot, "county-parcels");
  const camaDownload = resolveDir(countyRoot, legacyRoot, "auditor-cama-download");

  return {
    countyId,
    dataRoot,
    countyRoot,
    legacyRoot,
    usesLegacyDataRoot: dataRoot === legacyRoot,

    countyParcels,
    camaDownload,
    compIndex: resolvePath(countyRoot, legacyRoot, path.join("county-parcels", "comp-index.jsonl")),
    compIndexAuditor: resolvePath(
      countyRoot,
      legacyRoot,
      path.join("county-parcels", "comp-index-auditor.jsonl")
    ),
    salesEvents: resolvePath(countyRoot, legacyRoot, path.join("county-parcels", "sales-events.jsonl")),
    salesEventsManifest: resolvePath(
      countyRoot,
      legacyRoot,
      path.join("county-parcels", "sales-events-manifest.json")
    ),
    countyArvByParcel: resolvePath(
      countyRoot,
      legacyRoot,
      path.join("county-parcels", "county-arv-by-parcel.json")
    ),

    leadCards: resolvePath(countyRoot, legacyRoot, "lead-cards.json"),
    leadArvByParcel: resolvePath(countyRoot, legacyRoot, "lead-arv-by-parcel.json"),
    leadLinks: resolvePath(countyRoot, legacyRoot, "lead-links.json"),
    leadLinksCsv: resolvePath(countyRoot, legacyRoot, "lead-links.csv"),
    leadParcelIndex: resolvePath(countyRoot, legacyRoot, "lead-parcel-index.json"),
    leadSuppressions: resolvePath(countyRoot, legacyRoot, "lead-suppressions.jsonl"),
    leadOwnerSnapshots: resolvePath(countyRoot, legacyRoot, "lead-owner-snapshots.json"),
    leadStaleCandidates: resolvePath(countyRoot, legacyRoot, "lead-stale-candidates.json"),
    leadReinstatements: resolvePath(countyRoot, legacyRoot, "lead-reinstatements.jsonl"),
    agentFeedback: resolvePath(countyRoot, legacyRoot, "agent-feedback.jsonl"),
    agentCalibration: resolvePath(countyRoot, legacyRoot, "agent-calibration.json"),

    parcelOverlay: resolvePath(countyRoot, legacyRoot, path.join("auditor-cama-download", "parcel-overlay.json")),
    importManifest: resolvePath(
      countyRoot,
      legacyRoot,
      path.join("auditor-cama-download", "import-manifest.json")
    ),
    driveFileMap: resolvePath(
      countyRoot,
      legacyRoot,
      path.join("auditor-cama-download", "drive-file-map.json")
    ),

    scrapeState: resolvePath(countyRoot, legacyRoot, "scrape-state.json"),
    propertyProfilesByParcel: resolvePath(countyRoot, legacyRoot, "property-profiles-by-parcel.json"),
    propertyProfiles: resolvePath(countyRoot, legacyRoot, "property-profiles.json"),
    propertyProfileCache: resolvePath(countyRoot, legacyRoot, "property-profile-cache.json"),
    beaconSession: resolvePath(countyRoot, legacyRoot, "beacon-session.json"),
    beaconParcelCache: resolvePath(countyRoot, legacyRoot, "beacon-parcel-cache.json"),

    file: (name) => path.join(dataRoot, name),
  };
}

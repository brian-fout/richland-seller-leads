/**
 * @shared Dismiss / suppress leads so they stay out of queries after rebuild.
 * Suppressions persist across build-lead-cards runs (unlike cards, which are regenerated).
 */

import fs from "fs";
import path from "path";
import { normalizeOwnerName, ownersDiffer } from "./owner-contact.mjs";

export const DISMISS_REASONS = [
  "owner_changed",
  "sold",
  "paid_taxes",
  "not_distressed",
  "bad_data",
  "contacted_closed",
  "other",
];

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** @returns {Map<string, object>} */
export function loadSuppressions(filePath) {
  const map = new Map();
  if (!filePath || !fs.existsSync(filePath)) return map;

  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.parcel_id) map.set(rec.parcel_id, rec);
  }
  return map;
}

export function saveSuppressions(filePath, suppressions) {
  const lines = [...suppressions.values()]
    .sort((a, b) => String(a.parcel_id).localeCompare(String(b.parcel_id)))
    .map((rec) => JSON.stringify(rec));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.length ? `${lines.join("\n")}\n` : "");
}

/** Fingerprint distress signals so we can detect new list activity after dismiss. */
export function recordSignature(sourceId, rec) {
  const parts = [sourceId, rec.source_key ?? "?", rec.file_date ?? "?"];
  if (sourceId === "tax-liens" && rec.delinquent_year != null) {
    parts.push(`dy:${rec.delinquent_year}`);
  }
  return parts.join(":");
}

export function buildDistressFingerprint(clusterOrCard) {
  const recordsBySource = clusterOrCard?.records ?? {};
  const sources = clusterOrCard?.sources ?? Object.keys(recordsBySource).sort();
  const record_signatures = [];

  for (const sourceId of sources) {
    for (const rec of recordsBySource[sourceId] ?? []) {
      record_signatures.push(recordSignature(sourceId, rec));
    }
  }

  record_signatures.sort();
  return {
    sources: [...sources].sort(),
    record_signatures,
    record_count: record_signatures.length,
  };
}

export function findNewDistress(current, atDismiss) {
  if (!atDismiss?.record_signatures?.length) {
    // No baseline (legacy dismiss) — stay suppressed until manual --undismiss.
    return { hasNew: false, new_sources: [], new_records: [] };
  }

  const dismissedSources = new Set(atDismiss.sources ?? []);
  const dismissedRecords = new Set(atDismiss.record_signatures ?? []);
  const new_sources = (current?.sources ?? []).filter((s) => !dismissedSources.has(s));
  const new_records = (current?.record_signatures ?? []).filter((r) => !dismissedRecords.has(r));

  return {
    hasNew: new_sources.length > 0 || new_records.length > 0,
    new_sources,
    new_records,
  };
}

/**
 * Remove suppressions when parcel has new distress list activity since dismiss.
 * @param {Map<string, object>} suppressions
 * @param {Map<string, object>} clustersByParcel — parcel_id → link cluster
 */
export function applyDistressReinstatements(suppressions, clustersByParcel) {
  const reinstated = [];

  for (const [parcelId, suppression] of suppressions) {
    const cluster = clustersByParcel.get(parcelId);
    if (!cluster) continue;

    const current = buildDistressFingerprint(cluster);
    const delta = findNewDistress(current, suppression.distress_at_dismiss);
    if (!delta.hasNew) continue;

    suppressions.delete(parcelId);
    reinstated.push({
      parcel_id: parcelId,
      reinstated_at: new Date().toISOString(),
      prior_reason: suppression.reason ?? null,
      prior_dismissed_at: suppression.dismissed_at ?? null,
      new_sources: delta.new_sources,
      new_records: delta.new_records,
      current_sources: current.sources,
    });
  }

  return { reinstated, suppressions };
}

export function dismissParcel(suppressions, {
  parcel_id,
  reason = "other",
  notes = null,
  owner_at_dismiss = null,
  source = "manual",
  cluster = null,
  distress_at_dismiss = null,
} = {}) {
  if (!parcel_id) throw new Error("parcel_id required");
  const at = new Date().toISOString();
  const existing = suppressions.get(parcel_id);
  const fingerprint = distress_at_dismiss ?? (cluster ? buildDistressFingerprint(cluster) : null);
  const rec = {
    parcel_id,
    reason: clean(reason) || "other",
    notes: notes ? clean(notes) : null,
    owner_at_dismiss: owner_at_dismiss ? clean(owner_at_dismiss) : null,
    distress_at_dismiss: fingerprint,
    source,
    dismissed_at: at,
    updated_at: at,
    ...(existing?.first_dismissed_at ? { first_dismissed_at: existing.first_dismissed_at } : { first_dismissed_at: at }),
  };
  suppressions.set(parcel_id, rec);
  return rec;
}

export function undismissParcel(suppressions, parcelId) {
  return suppressions.delete(parcelId);
}

export function isSuppressed(suppressions, parcelId) {
  return suppressions.has(parcelId);
}

export function filterActiveCards(cards, suppressions) {
  if (!suppressions?.size) return cards;
  return cards.filter((c) => !isSuppressed(suppressions, c.parcel_id));
}

export function loadOwnerSnapshots(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function saveOwnerSnapshots(filePath, snapshots) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshots, null, 2));
}

/**
 * Compare current card owner to last build snapshot.
 * @returns {object[]} stale candidates (not already suppressed)
 */
export function detectOwnerChanges(cards, snapshots, suppressions = new Map()) {
  const stale = [];

  for (const card of cards) {
    if (isSuppressed(suppressions, card.parcel_id)) continue;

    const snap = snapshots[card.parcel_id];
    const currentOwner = card.contact_owner ?? card.owner_name ?? card.auditor_owner_name ?? null;
    const previousOwner = snap?.contact_owner ?? null;

    if (!snap || !previousOwner || !currentOwner) continue;
    if (!ownersDiffer(previousOwner, currentOwner)) continue;

    stale.push({
      parcel_id: card.parcel_id,
      address: card.address ?? null,
      city: card.city ?? null,
      sources: card.sources ?? [],
      previous_owner: previousOwner,
      current_owner: currentOwner,
      snapshot_at: snap.captured_at ?? null,
      detected_at: new Date().toISOString(),
      suggested_reason: "owner_changed",
    });
  }

  return stale.sort((a, b) => String(a.parcel_id).localeCompare(String(b.parcel_id)));
}

/** Update snapshots for active (non-suppressed) cards after a successful build. */
export function buildOwnerSnapshots(cards, suppressions = new Map()) {
  const at = new Date().toISOString();
  const next = {};

  for (const card of cards) {
    if (isSuppressed(suppressions, card.parcel_id)) continue;
    const owner = card.contact_owner ?? card.owner_name ?? card.auditor_owner_name ?? null;
    if (!owner) continue;
    next[card.parcel_id] = {
      contact_owner: clean(owner),
      contact_owner_normalized: normalizeOwnerName(owner),
      contact_owner_source: card.contact_owner_source ?? null,
      captured_at: at,
    };
  }

  return next;
}

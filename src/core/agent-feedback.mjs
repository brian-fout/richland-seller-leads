/**
 * @shared Agent / human ground-truth feedback (free-form text).
 * Raw notes are always stored; structured fields are best-effort hints only.
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const PARCEL_RE = /\b(\d{3}-\d{2}-\d{3}-\d{2}-\d{3})\b/gi;
const MONEY_RE = /\$?\s*([\d,]+(?:\.\d{1,2})?)\s*([kK])?\b/g;

function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoneyToken(raw, suffix) {
  let n = parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (suffix) n *= 1000;
  return Math.round(n);
}

/** Pull dollar amounts with nearby keyword context. */
export function extractMoneyMentions(text) {
  const mentions = [];
  const lower = text.toLowerCase();

  for (const match of text.matchAll(MONEY_RE)) {
    const amount = parseMoneyToken(match[1], match[2]);
    if (amount == null || amount < 500) continue;
    const idx = match.index ?? 0;
    const window = lower.slice(Math.max(0, idx - 40), idx + 40);
    mentions.push({ amount, context: window });
  }
  return mentions;
}

function pickAmount(mentions, keywords) {
  for (const m of mentions) {
    if (keywords.some((k) => m.context.includes(k))) return m.amount;
  }
  return null;
}

function detectVerdict(text) {
  const lower = text.toLowerCase();
  if (/\b(pass|skip|avoid|no\s+go|not\s+a\s+deal|stay\s+away|too\s+rough|don't\s+buy|dont\s+buy)\b/.test(lower)) {
    return "pass";
  }
  if (/\b(good\s+deal|make\s+offer|go\s+for\s+it|worth\s+pursuing|yes|buy\s+it|strong\s+lead)\b/.test(lower)) {
    return "pursue";
  }
  if (/\b(maybe|borderline|iffy|needs\s+work|rough)\b/.test(lower)) {
    return "maybe";
  }
  return null;
}

function detectRange(text, mentions) {
  const rangeMatch = text.match(
    /\$?\s*([\d,]+(?:\.\d+)?)\s*([kK])?\s*[-–—to]+\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([kK])?/i
  );
  if (rangeMatch) {
    const low = parseMoneyToken(rangeMatch[1], rangeMatch[2]);
    const high = parseMoneyToken(rangeMatch[3], rangeMatch[4]);
    if (low != null && high != null) return { low: Math.min(low, high), high: Math.max(low, high) };
  }

  const arvMentions = mentions.filter((m) => /arv|retail|rehab|after\s+repair|fixed\s+up|market/.test(m.context));
  if (arvMentions.length >= 2) {
    const amounts = arvMentions.map((m) => m.amount).sort((a, b) => a - b);
    return { low: amounts[0], high: amounts[amounts.length - 1] };
  }
  return null;
}

/**
 * Best-effort parse — never throws; missing fields are fine.
 */
export function parseFreeformFeedback(rawText, { parcel_id = null } = {}) {
  const raw_text = clean(rawText);
  const parcels = [...new Set([...(parcel_id ? [parcel_id] : []), ...[...raw_text.matchAll(PARCEL_RE)].map((m) => m[1].toUpperCase())])];
  const mentions = extractMoneyMentions(raw_text);

  const arv_amount =
    pickAmount(mentions, ["arv", "retail", "after repair", "rehabbed", "market value", "sell for"]) ??
    pickAmount(mentions, ["worth", "value"]);
  const rehab_estimate = pickAmount(mentions, ["rehab", "repair", "fix", "renovation", "work needed"]);
  const offer_max = pickAmount(mentions, ["offer", "mao", "max offer", "pay", "buy at", "wholesale"]);
  const range = detectRange(raw_text, mentions);
  const verdict = detectVerdict(raw_text);

  const parsed = {
    parcel_ids: parcels,
    arv_amount,
    arv_range: range,
    rehab_estimate,
    offer_max,
    verdict,
    money_mentions: mentions.slice(0, 8),
  };

  Object.keys(parsed).forEach((k) => {
    if (parsed[k] == null || (Array.isArray(parsed[k]) && !parsed[k].length)) delete parsed[k];
  });

  return parsed;
}

export function loadAgentFeedback(filePath) {
  const entries = [];
  if (!filePath || !fs.existsSync(filePath)) return entries;

  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line));
  }
  return entries;
}

export function appendAgentFeedback(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

export function saveAgentCalibration(filePath, calibration) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(calibration, null, 2));
}

/**
 * Latest feedback per parcel wins; merges parsed hints into calibration record.
 */
export function rebuildAgentCalibration(entries) {
  const byParcel = new Map();

  for (const entry of entries) {
    const parcelIds = entry.parcel_id
      ? [entry.parcel_id]
      : entry.parsed?.parcel_ids ?? [];

    for (const parcelId of parcelIds) {
      const prev = byParcel.get(parcelId) ?? { parcel_id: parcelId, feedback_ids: [] };
      const parsed = entry.parsed ?? {};
      const next = {
        ...prev,
        parcel_id: parcelId,
        updated_at: entry.submitted_at,
        latest_feedback_id: entry.id,
        raw_text: entry.raw_text,
        source: entry.source ?? "agent",
        feedback_count: (prev.feedback_count ?? 0) + 1,
        feedback_ids: [...(prev.feedback_ids ?? []), entry.id],
      };

      if (parsed.arv_amount != null) next.agent_arv = parsed.arv_amount;
      if (parsed.arv_range) next.agent_arv_range = parsed.arv_range;
      if (parsed.rehab_estimate != null) next.agent_rehab_estimate = parsed.rehab_estimate;
      if (parsed.offer_max != null) next.agent_offer_max = parsed.offer_max;
      if (parsed.verdict) next.agent_verdict = parsed.verdict;
      if (entry.address) next.address = entry.address;

      byParcel.set(parcelId, next);
    }
  }

  const parcels = [...byParcel.values()].sort((a, b) => a.parcel_id.localeCompare(b.parcel_id));
  return {
    generated_at: new Date().toISOString(),
    parcel_count: parcels.length,
    parcels,
    by_parcel: Object.fromEntries(byParcel),
  };
}

export function loadAgentCalibration(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { generated_at: null, parcel_count: 0, parcels: [], by_parcel: {} };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function getAgentCalibrationForParcel(calibration, parcelId) {
  return calibration?.by_parcel?.[parcelId] ?? null;
}

export function compareAgentToModel(agent, modelArv) {
  if (!agent || modelArv == null) return null;
  const agentMid = agent.agent_arv ?? agent.agent_arv_range?.high ?? agent.agent_arv_range?.low ?? null;
  if (agentMid == null) return null;
  const delta = agentMid - modelArv;
  const pct = modelArv ? Math.round((delta / modelArv) * 100) : null;
  return { agent_mid: agentMid, model_arv: modelArv, delta, delta_pct: pct };
}

export function recordFeedback(filePath, calibrationPath, {
  raw_text,
  parcel_id = null,
  address = null,
  source = "agent",
  submitted_by = null,
} = {}) {
  if (!clean(raw_text)) throw new Error("raw_text required");

  const parsed = parseFreeformFeedback(raw_text, { parcel_id });
  const entry = {
    id: randomUUID(),
    submitted_at: new Date().toISOString(),
    source,
    submitted_by,
    parcel_id: parcel_id ?? parsed.parcel_ids?.[0] ?? null,
    address,
    raw_text: clean(raw_text),
    parsed,
  };

  appendAgentFeedback(filePath, entry);
  const all = loadAgentFeedback(filePath);
  saveAgentCalibration(calibrationPath, rebuildAgentCalibration(all));
  return entry;
}

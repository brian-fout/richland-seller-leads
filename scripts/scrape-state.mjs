/**
 * Tracks last successful run per source for incremental scraping.
 * State file: data/scrape-state.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_PATH = path.join(DATA_DIR, "scrape-state.json");

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function getSourceState(sourceId) {
  return readState()[sourceId] ?? null;
}

export function markSourceRun(sourceId, fields = {}) {
  const state = readState();
  state[sourceId] = {
    ...state[sourceId],
    last_run_at: new Date().toISOString(),
    ...fields,
  };
  writeState(state);
  return state[sourceId];
}

/** Jan 1 of the current year — used only when a source has never run. */
export function bootstrapUsDate() {
  const year = new Date().getFullYear();
  return `01/01/${year}`;
}

export function fmtUsDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/** Next calendar day after last successful to-date, or Jan 1 on first run. */
export function incrementalFromUsDate(sourceId) {
  const prev = getSourceState(sourceId);
  if (!prev?.last_to_date) return bootstrapUsDate();
  const last = parseUsDate(prev.last_to_date);
  if (!last) return bootstrapUsDate();
  last.setDate(last.getDate() + 1);
  return fmtUsDate(last);
}

export function parseUsDate(str) {
  const m = String(str).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
}

export function onOrAfterUsDate(value, sinceUsDate) {
  if (!sinceUsDate) return true;
  const since = parseUsDate(sinceUsDate);
  const valueDate = parseUsDate(value);
  if (!since || !valueDate) return true;
  return valueDate >= since;
}

export function loadCanonicalRecords(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(raw) ? raw : (raw.records ?? []);
  } catch {
    return [];
  }
}

export function saveCanonicalRecords(filename, records) {
  const filePath = path.join(DATA_DIR, filename);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
}

export function mergeByKey(existing, incoming, keyFn) {
  const map = new Map();
  for (const row of existing) {
    const key = keyFn(row);
    if (key) map.set(key, row);
  }
  for (const row of incoming) {
    const key = keyFn(row);
    if (key) map.set(key, row);
  }
  return [...map.values()];
}

export function toCsv(records) {
  if (records.length === 0) return "";
  const headers = Object.keys(records[0]);
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [
    headers.join(","),
    ...records.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

export function writeRunOutputs(baseName, deltaRecords, canonicalRecords) {
  const stamp = new Date().toISOString().slice(0, 10);
  const deltaJson = path.join(DATA_DIR, `${baseName}-${stamp}.json`);
  const deltaCsv = path.join(DATA_DIR, `${baseName}-${stamp}.csv`);
  const canonicalJson = path.join(DATA_DIR, `${baseName}-canonical.json`);
  const canonicalCsv = path.join(DATA_DIR, `${baseName}-canonical.csv`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(deltaJson, JSON.stringify(deltaRecords, null, 2));
  fs.writeFileSync(deltaCsv, toCsv(deltaRecords));
  fs.writeFileSync(canonicalJson, JSON.stringify(canonicalRecords, null, 2));
  fs.writeFileSync(canonicalCsv, toCsv(canonicalRecords));

  return { stamp, deltaJson, deltaCsv, canonicalJson, canonicalCsv };
}

/** ISO date stamp from US date label, e.g. 01/05/2026 → 2026-01-05 */
export function dayFileStamp(usDateLabel) {
  const d = parseUsDate(usDateLabel);
  if (!d) return usDateLabel.replace(/\//g, "-");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayOutputPaths(baseName, usDateLabel) {
  const stamp = dayFileStamp(usDateLabel);
  return {
    stamp,
    json: path.join(DATA_DIR, `${baseName}-day-${stamp}.json`),
    csv: path.join(DATA_DIR, `${baseName}-day-${stamp}.csv`),
  };
}

export function dayOutputExists(baseName, usDateLabel) {
  return fs.existsSync(dayOutputPaths(baseName, usDateLabel).json);
}

export function loadDayRecords(baseName, usDateLabel) {
  const { json } = dayOutputPaths(baseName, usDateLabel);
  try {
    const raw = JSON.parse(fs.readFileSync(json, "utf8"));
    return Array.isArray(raw) ? raw : (raw.records ?? []);
  } catch {
    return [];
  }
}

export function writeDayOutputs(baseName, usDateLabel, records) {
  const { stamp, json, csv } = dayOutputPaths(baseName, usDateLabel);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(json, JSON.stringify(records, null, 2));
  fs.writeFileSync(csv, toCsv(records));
  return { stamp, json, csv };
}

export function loadAllDayRecords(baseName, keyFn) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prefix = `${baseName}-day-`;
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();

  let records = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
      const rows = Array.isArray(raw) ? raw : (raw.records ?? []);
      records = mergeByKey(records, rows, keyFn);
    } catch {
      // skip corrupt day files
    }
  }
  return records;
}

export function writeCanonicalFromDays(baseName, keyFn) {
  const canonical = loadAllDayRecords(baseName, keyFn);
  const canonicalJson = path.join(DATA_DIR, `${baseName}-canonical.json`);
  const canonicalCsv = path.join(DATA_DIR, `${baseName}-canonical.csv`);
  fs.writeFileSync(canonicalJson, JSON.stringify(canonical, null, 2));
  fs.writeFileSync(canonicalCsv, toCsv(canonical));
  return { canonical, canonicalJson, canonicalCsv };
}

/** Month stamp, e.g. year=2026 month=1 → 2026-01 */
export function monthFileStamp(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function monthOutputPaths(baseName, year, month) {
  const stamp = monthFileStamp(year, month);
  return {
    stamp,
    json: path.join(DATA_DIR, `${baseName}-month-${stamp}.json`),
    csv: path.join(DATA_DIR, `${baseName}-month-${stamp}.csv`),
  };
}

export function monthOutputExists(baseName, year, month) {
  return fs.existsSync(monthOutputPaths(baseName, year, month).json);
}

export function loadMonthRecords(baseName, year, month) {
  const { json } = monthOutputPaths(baseName, year, month);
  try {
    const raw = JSON.parse(fs.readFileSync(json, "utf8"));
    return Array.isArray(raw) ? raw : (raw.records ?? []);
  } catch {
    return [];
  }
}

export function writeMonthOutputs(baseName, year, month, records) {
  const { stamp, json, csv } = monthOutputPaths(baseName, year, month);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(json, JSON.stringify(records, null, 2));
  fs.writeFileSync(csv, toCsv(records));
  return { stamp, json, csv };
}

export function loadAllMonthRecords(baseName, keyFn) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prefix = `${baseName}-month-`;
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();

  let records = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
      const rows = Array.isArray(raw) ? raw : (raw.records ?? []);
      records = mergeByKey(records, rows, keyFn);
    } catch {
      // skip corrupt month files
    }
  }
  return records;
}

export function writeCanonicalFromMonths(baseName, keyFn) {
  const canonical = loadAllMonthRecords(baseName, keyFn);
  const canonicalJson = path.join(DATA_DIR, `${baseName}-canonical.json`);
  const canonicalCsv = path.join(DATA_DIR, `${baseName}-canonical.csv`);
  fs.writeFileSync(canonicalJson, JSON.stringify(canonical, null, 2));
  fs.writeFileSync(canonicalCsv, toCsv(canonical));
  return { canonical, canonicalJson, canonicalCsv };
}

/**
 * @county richland — Parsers for Ohio AA407 auditor CAMA Update fixed-width .DAT exports.
 * Other counties may reuse patterns but need their own parser module under src/counties/{id}/.
 */

import fs from "fs";
import readline from "readline";
import path from "path";
import { paths } from "../src/core/county-context.mjs";
import { keyValueToParcelId } from "./beacon-parcel.mjs";
import {
  ASMT,
  CHARGE,
  DWELL,
  OWNDATMAX,
  realisticTaxYear,
  sliceField,
} from "../src/counties/richland/aa407-layout.mjs";

/** Richland CAMA download dir (county-scoped via --county, legacy data/ fallback). */
export const CAMA_DIR = paths().camaDownload;

const MONTHS = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

export function parseAuditorDate(value) {
  const text = String(value ?? "").trim();
  const m = text.match(/^(\d{2})-([A-Z]{3})-(\d{2})$/);
  if (!m) return null;
  const year = 2000 + parseInt(m[3], 10);
  const month = MONTHS[m[2]];
  if (month == null) return null;
  const day = parseInt(m[1], 10);
  const d = new Date(Date.UTC(year, month, day));
  const iso = Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  return iso && isRealisticSaleDate(iso) ? iso : null;
}

/** Reject fixed-width year bugs (e.g. 2099) and far-future dates. */
export function isRealisticSaleDate(dateIso) {
  if (!dateIso) return false;
  const year = parseInt(dateIso.slice(0, 4), 10);
  const now = new Date();
  if (year < 1990 || year > now.getUTCFullYear() + 1) return false;
  const maxFuture = new Date(now);
  maxFuture.setUTCDate(maxFuture.getUTCDate() + 14);
  return dateIso <= maxFuture.toISOString().slice(0, 10);
}

function cleanName(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const CSZ_RE = /^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;

function looksLikeStreet(text) {
  if (!text) return false;
  if (/^\d/.test(text)) return true;
  return /\b(PO BOX|P\.?O\.?\s*BOX|RT|ST|DR|RD|AVE|LN|BLVD|HWY|DRIVE|STREET|ROAD|WAY|COURT|CT)\b/i.test(text);
}

function looksLikeNameContinuation(text) {
  return /^(&|AND\s)/i.test(text) || /^[A-Z]\s+[A-Z]/i.test(text);
}

function parseCityStateZip(text) {
  if (!text) return null;
  const m = cleanName(text).match(CSZ_RE);
  if (!m) return null;
  return { city: m[1].trim(), state: m[2], zip: m[3] };
}

/** Owner + mailing from OWNDATMAX double-space columns. */
export function parseOwndatmaxMailing(line) {
  const tail = line.slice(OWNDATMAX.owner_name_start);
  const parts = tail.split(/\s{2,}/).map(cleanName).filter(Boolean);
  if (!parts.length) return null;

  const nameParts = [parts[0].replace(/^\d/, "")];
  let i = 1;
  while (i < parts.length && !looksLikeStreet(parts[i]) && !parseCityStateZip(parts[i])) {
    if (looksLikeNameContinuation(parts[i]) || /^[A-Z]/.test(parts[i])) {
      nameParts.push(parts[i]);
      i++;
    } else break;
  }

  let mailing_street = null;
  let mailing_city = null;
  let mailing_state = null;
  let mailing_zip = null;

  if (i < parts.length && looksLikeStreet(parts[i])) {
    mailing_street = parts[i++];
  }
  if (i < parts.length) {
    const csz = parseCityStateZip(parts[i]);
    if (csz) {
      mailing_city = csz.city;
      mailing_state = csz.state;
      mailing_zip = csz.zip;
      i++;
    }
  }

  const owner_name = cleanName(nameParts.join(" "));
  if (!owner_name) return null;

  const mailing_address = [mailing_street, mailing_city, mailing_state, mailing_zip]
    .filter(Boolean)
    .join(", ");

  return {
    owner_name,
    mailing_street,
    mailing_city,
    mailing_state,
    mailing_zip,
    mailing_address: mailing_address || null,
  };
}

export function parseOwndatmaxLine(line) {
  if (!/^\d{13}/.test(line)) return null;
  const parcelKey = sliceField(line, OWNDATMAX.parcel_key).trim();
  const tax_year = realisticTaxYear(sliceField(line, OWNDATMAX.tax_year));
  if (!tax_year) return null;

  const parsed = parseOwndatmaxMailing(line);
  if (!parsed?.owner_name) return null;

  return {
    parcel_key: parcelKey,
    parcel_id: keyValueToParcelId(parcelKey),
    owner_name: parsed.owner_name,
    mailing_street: parsed.mailing_street,
    mailing_city: parsed.mailing_city,
    mailing_state: parsed.mailing_state,
    mailing_zip: parsed.mailing_zip,
    mailing_address: parsed.mailing_address,
    tax_year,
    owner_type: sliceField(line, OWNDATMAX.owner_type).trim() || null,
  };
}

export function parseAsmtLine(line) {
  if (!/^\d{13}/.test(line)) return null;
  const parcelKey = sliceField(line, ASMT.parcel_key).trim();
  const assessment_tax_year = realisticTaxYear(sliceField(line, ASMT.tax_year));
  if (!assessment_tax_year) return null;

  const m = line.slice(ASMT.values_start).match(/^\s*(\d)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
  if (!m) return null;

  const land_value = parseInt(m[2], 10);
  const building_value = parseInt(m[3], 10);
  const total_appraised_value = parseInt(m[6], 10) || land_value + building_value;

  return {
    parcel_key: parcelKey,
    parcel_id: keyValueToParcelId(parcelKey),
    assessment_tax_year,
    land_value,
    building_value,
    total_appraised_value,
  };
}

function parseChargeAmounts(line) {
  return [...line.slice(CHARGE.amounts_start).matchAll(/(-?\d+\.\d{2})/g)].map((m) =>
    parseFloat(m[1])
  );
}

export function parseChargeLine(line) {
  if (!/^\d{13}/.test(line)) return null;
  const parcelKey = sliceField(line, CHARGE.parcel_key).trim();
  const tax_year = realisticTaxYear(sliceField(line, CHARGE.tax_year));
  if (!tax_year) return null;

  const amounts = parseChargeAmounts(line);
  const prior_delinquent = amounts[CHARGE.prior_delinquent_amount_index] ?? null;
  const positiveAmounts = amounts.filter((a) => a > 0);
  const net_delinquency_due = positiveAmounts.length ? positiveAmounts[positiveAmounts.length - 1] : null;
  const maintenance_date = line.match(/(\d{2}-[A-Z]{3}-\d{2})\s*$/)?.[1] ?? null;
  const charge_header = cleanName(line.slice(CHARGE.amounts_start, CHARGE.amounts_start + 40).split(/\d/)[0]);

  return {
    parcel_key: parcelKey,
    parcel_id: keyValueToParcelId(parcelKey),
    tax_year,
    charge_header: charge_header || null,
    amounts,
    prior_delinquent: prior_delinquent > 0 ? prior_delinquent : null,
    net_delinquency_due: net_delinquency_due > 0 ? net_delinquency_due : null,
    is_delinquent: (prior_delinquent ?? 0) > 0 || (net_delinquency_due ?? 0) > 0,
    maintenance_date,
    source: "charge_dat",
  };
}

export function loadChargeIndex(filePath = path.join(CAMA_DIR, "CHARGE.DAT")) {
  if (!fs.existsSync(filePath)) return new Map();
  const map = new Map();
  const text = fs.readFileSync(filePath, "latin1");
  for (const line of text.split("\n")) {
    const rec = parseChargeLine(line);
    if (rec?.parcel_id) map.set(rec.parcel_id, rec);
  }
  return map;
}

/** Richland DWELL.DAT — AA407-style fixed width (record length 1177). Positions derived from layout probe. */
const DWELL_HEADER_RE =
  /^(\d{13})\s+\d{3}\s+(\d)\s+(20\d{2})\s+\d\s+([\d.]+)\s+(\d{2})\s+(\d{4})(?:\s+(\d{4}))?\s+(\d+)\s+(\d+)\s+\d\s+(\d+)\s+(\d+)\s+(\d+)/;
const DWELL_SQFT_RE = /\s{3,}0\s+(\d{3,5})\s+\d\.\d{3}/;

export function parseDwellLine(line) {
  if (!/^\d{13}/.test(line)) return null;
  const m = line.match(DWELL_HEADER_RE);
  if (!m) return null;

  const sqftM = line.match(DWELL_SQFT_RE);
  const gradeRaw = sliceField(line, DWELL.grade).trim();
  const grade = gradeRaw.match(/^[A-Z][+-]?0?/)?.[0] ?? (gradeRaw || null);
  const conditionRaw = sliceField(line, DWELL.condition).trim().toUpperCase();
  const condition =
    /^[A-Z]{2}$/.test(conditionRaw) || /^(P-|V-)$/.test(conditionRaw) ? conditionRaw : null;
  const styleCode = parseInt(m[5], 10);

  return {
    parcel_key: m[1],
    parcel_id: keyValueToParcelId(m[1]),
    dwell_card: parseInt(m[2], 10),
    dwell_tax_year: parseInt(m[3], 10),
    stories: parseFloat(m[4]),
    style: Number.isFinite(styleCode) ? String(styleCode) : m[5],
    year_built: parseInt(m[6], 10),
    year_remodeled: m[7] ? parseInt(m[7], 10) : null,
    rooms: parseInt(m[8], 10),
    bedrooms: parseInt(m[9], 10),
    full_bath: parseInt(m[10], 10),
    half_bath: parseInt(m[11], 10),
    square_footage: sqftM ? parseInt(sqftM[1], 10) : null,
    grade,
    condition,
    source: "dwelling_dat",
  };
}

function pickBetterDwell(prev, next) {
  const prevSqft = prev.square_footage ?? 0;
  const nextSqft = next.square_footage ?? 0;
  if (nextSqft > prevSqft) return next;
  if (nextSqft < prevSqft) return prev;
  if (next.dwell_card < prev.dwell_card) return next;
  return prev;
}

export async function loadDwellIndex(filePath = path.join(CAMA_DIR, "DWELL.DAT")) {
  if (!fs.existsSync(filePath)) return new Map();
  const map = new Map();
  await readDatLines(filePath, (line) => {
    const rec = parseDwellLine(line);
    if (!rec?.parcel_id) return;
    const prev = map.get(rec.parcel_id);
    map.set(rec.parcel_id, prev ? pickBetterDwell(prev, rec) : rec);
  });
  return map;
}

export function loadDwellIndexSync(filePath = path.join(CAMA_DIR, "DWELL.DAT")) {
  if (!fs.existsSync(filePath)) return new Map();
  const map = new Map();
  const stream = fs.readFileSync(filePath, "latin1");
  for (const line of stream.split("\n")) {
    const rec = parseDwellLine(line);
    if (!rec?.parcel_id) continue;
    const prev = map.get(rec.parcel_id);
    map.set(rec.parcel_id, prev ? pickBetterDwell(prev, rec) : rec);
  }
  return map;
}

export function parsePardatLine(line) {
  if (!/^\d{13}/.test(line)) return null;
  const parcelKey = line.slice(0, 13).trim();
  const m = line.match(
    /(\d{1,6})\s+(ST|AVE|DR|RD|LN|CT|BLVD|WAY|PL|CIR|PKWY|HWY|TRL|TER|LOOP)\s+([NSEW])?\s+([A-Z0-9 \-'\.]+?)\s{2,}/i
  );
  if (!m) {
    return { parcel_key: parcelKey, parcel_id: keyValueToParcelId(parcelKey), address: null };
  }
  const suffix = m[4].trim().split(/\s{2,}/)[0];
  const parts = [m[1], m[2], m[3], suffix].filter(Boolean);
  return {
    parcel_key: parcelKey,
    parcel_id: keyValueToParcelId(parcelKey),
    address: cleanName(parts.join(" ")),
  };
}

/** Ohio CAMA validity: 2 = valid arm's-length sale (matches Beacon VALID SALE). */
export const VALID_SALE_CODES = new Set([2]);

export function parseSalesLine(line) {
  if (!/^\d{13}/.test(line)) return null;
  const parcelKey = line.slice(0, 13).trim();
  const header = line.match(/(\d{4})\s+(\d)\s+(\d{4})\s+(\d+)\s+(\d+)/);
  const datePrice = line.match(/(\d{2}-[A-Z]{3}-\d{2})\s+(\d+)\s+(\d)/);
  if (!datePrice) return null;

  const sale_price = parseInt(datePrice[2], 10);
  const validity_code = parseInt(datePrice[3], 10);
  const sale_date = parseAuditorDate(datePrice[1]);

  const grantorBlock = line.slice(80, 260);
  const grantor = cleanName(grantorBlock.match(/^\s*\d+\s+(.+?)\s{2,}/)?.[1] ?? "");
  const granteeBlock = line.slice(260, 440);
  const grantee = cleanName(
    granteeBlock.match(/^(.+?)\s{2,}/)?.[1]?.split(/\s{2,}/)[0] ?? granteeBlock.trim().split(/\s{2,}/)[0]
  );

  return {
    parcel_key: parcelKey,
    parcel_id: keyValueToParcelId(parcelKey),
    sale_year: header ? parseInt(header[1], 10) : null,
    sale_type_code: header ? parseInt(header[4], 10) : null,
    sale_key: header ? header[5] : null,
    sale_date,
    sale_price,
    validity_code,
    is_valid_sale: VALID_SALE_CODES.has(validity_code) && sale_price > 0,
    grantor: grantor || null,
    grantee: grantee || null,
  };
}

export async function readDatLines(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: "latin1" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (/^\d{13}/.test(line)) await onLine(line);
  }
}

export function loadOwndatmaxIndex(filePath = path.join(CAMA_DIR, "OWNDATMAX.DAT")) {
  const text = fs.readFileSync(filePath, "latin1");
  const map = new Map();
  for (const line of text.split("\n")) {
    const rec = parseOwndatmaxLine(line);
    if (rec?.parcel_id) map.set(rec.parcel_id, rec);
  }
  return map;
}

export function loadAsmtIndex(filePath = path.join(CAMA_DIR, "ASMT.DAT")) {
  const text = fs.readFileSync(filePath, "latin1");
  const map = new Map();
  for (const line of text.split("\n")) {
    const rec = parseAsmtLine(line);
    if (rec?.parcel_id) map.set(rec.parcel_id, rec);
  }
  return map;
}

export function loadPardatIndex(filePath = path.join(CAMA_DIR, "PARDAT.DAT")) {
  const text = fs.readFileSync(filePath, "latin1");
  const map = new Map();
  for (const line of text.split("\n")) {
    const rec = parsePardatLine(line);
    if (rec?.parcel_id) map.set(rec.parcel_id, rec);
  }
  return map;
}

/** Latest valid sale per parcel (by sale_date). */
export function loadLatestValidSales(filePath = path.join(CAMA_DIR, "SALES.DAT")) {
  const text = fs.readFileSync(filePath, "latin1");
  const byParcel = new Map();
  for (const line of text.split("\n")) {
    const rec = parseSalesLine(line);
    if (!rec?.parcel_id || !rec.is_valid_sale) continue;
    const prev = byParcel.get(rec.parcel_id);
    if (!prev || (rec.sale_date && (!prev.sale_date || rec.sale_date > prev.sale_date))) {
      byParcel.set(rec.parcel_id, rec);
    }
  }
  return byParcel;
}

/** All valid sales in lookback window for comp analysis. */
export function loadValidSalesSince(
  monthsBack = 24,
  filePath = path.join(CAMA_DIR, "SALES.DAT")
) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const sales = [];
  const text = fs.readFileSync(filePath, "latin1");
  for (const line of text.split("\n")) {
    const rec = parseSalesLine(line);
    if (!rec?.parcel_id || !rec.is_valid_sale || !rec.sale_date) continue;
    if (rec.sale_date >= cutoffIso) sales.push(rec);
  }
  return sales;
}

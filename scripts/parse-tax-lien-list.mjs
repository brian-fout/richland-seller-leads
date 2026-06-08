/**
 * Parse Richland County Prosecutor's Delinquent Land List PDF
 * into structured CSV and JSON (tax lien leads).
 *
 * Usage:
 *   npm run parse:tax-lien-list
 *   npm run parse:tax-lien-list -- path/to/Prosecutor List.pdf
 *   Drop PDF in data/counties/richland/inbox/ — auto-discovered on run.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { paths } from "../src/core/county-context.mjs";
import { findLatestTaxLienPdf } from "../src/core/tax-lien-discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PARCEL_ID_RE = /\d{3}-\d{2}-\d{3}-\d{2}-\d{3}/;
const CSZ_RE = /^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;
const GARBAGE_RE =
  /PROSECUTOR|DELINQUENT\s+LAND\s+LIST|TAXING\s+DISTRICT|DISTRICT\s+TOTALS|COUNT\s+OF\s+PARCELS|TX104OH|^PAGE:/i;

/** Assign text item to column bucket by x position. */
function columnFor(x) {
  if (x < 90) return "parcel";
  if (x < 145) return "prior_delq";
  if (x < 340) return "name_address";
  if (x < 560) return "legal";
  if (x < 650) return "acres";
  if (x < 690) return "values";
  return "cert";
}

function joinWords(items) {
  return items
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMoney(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isGarbage(text) {
  return !text || GARBAGE_RE.test(text);
}

function looksLikeStreet(text) {
  if (!text) return false;
  if (/^\d/.test(text)) return true;
  return /\b(PO BOX|ROUTE|RT|ST|DR|RD|AVE|LN|BLVD|HWY|DRIVE|STREET|ROAD|WAY|COURT|CT|MCQUISTON)\b/i.test(
    text
  );
}

function looksLikeNameContinuation(text) {
  return /^(&|AND\s)/i.test(text) || /^A\s+[A-Z]/i.test(text);
}

function parseCityStateZip(text) {
  if (!text) return null;
  const m = text.match(CSZ_RE);
  if (!m) return null;
  return { city: m[1].trim(), state: m[2], zip: m[3] };
}

function outputBaseName(pdfPath) {
  const pdfBase = path.basename(pdfPath, path.extname(pdfPath));
  const dateMatch = pdfBase.match(/(\d{1,2}-\d{1,2}-\d{4})/);
  const datePart = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
  return `tax-lien-list-${datePart}`;
}

async function extractPageRows(page) {
  const content = await page.getTextContent();
  const items = content.items
    .filter((it) => it.str?.trim())
    .map((it) => ({
      str: it.str.trim(),
      x: Math.round(it.transform[4]),
      y: Math.round(it.transform[5]),
    }));

  const rowMap = new Map();
  for (const it of items) {
    const existing = [...rowMap.keys()].find((k) => Math.abs(k - it.y) <= 3);
    const y = existing ?? it.y;
    if (!rowMap.has(y)) rowMap.set(y, []);
    rowMap.get(y).push(it);
  }

  return [...rowMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, rowItems]) => {
      rowItems.sort((a, b) => a.x - b.x);
      const cols = {
        parcel: [],
        prior_delq: [],
        name_address: [],
        legal: [],
        acres: [],
        values: [],
        cert: [],
      };
      for (const it of rowItems) {
        cols[columnFor(it.x)].push(it);
      }
      return { y, cols, raw: rowItems };
    });
}

function isPageHeaderRow(row) {
  const line = joinWords(row.raw);
  return (
    line.includes("RICHLAND") ||
    line.includes("TX104OH") ||
    line.includes("PARCEL/STUB") ||
    line.includes("PRIOR") ||
    /^OCT\s+\d+/i.test(line) ||
    /^\d{2}:\d{2}\s+AM/i.test(line)
  );
}

function isDistrictHeaderRow(row) {
  return joinWords(row.cols.parcel).includes("TAXING DISTRICT");
}

function isDistrictFooterRow(row) {
  const line = joinWords(row.raw);
  return line.includes("DISTRICT TOTALS") || line.includes("COUNT OF PARCELS");
}

function parseDistrictHeader(row) {
  const items = row.raw.filter((i) => i.x >= 130);
  const code = items.find((i) => /^\d{5}$/.test(i.str))?.str;
  if (!code) return null;
  const nameParts = items
    .filter((i) => i.str !== code && i.str !== "/")
    .map((i) => i.str);
  return { code, name: nameParts.join(" ") };
}

function parseDistrictTotals(rows, startIdx) {
  const totals = { real: null, special: null, total: null, parcel_count: null };
  for (let i = startIdx; i < rows.length; i++) {
    const line = joinWords(rows[i].raw);
    if (line.includes("REAL:"))
      totals.real = parseMoney(line.match(/REAL:\s*([\d,]+\.?\d*)/)?.[1]);
    if (line.includes("SPECIAL:"))
      totals.special = parseMoney(line.match(/SPECIAL:\s*([\d,]+\.?\d*)/)?.[1]);
    if (/TOTAL:/.test(line) && !line.includes("DISTRICT"))
      totals.total = parseMoney(line.match(/TOTAL:\s*([\d,]+\.?\d*)/)?.[1]);
    const countMatch = line.match(/COUNT OF PARCELS:\s*(\d+)/);
    if (countMatch) totals.parcel_count = parseInt(countMatch[1], 10);
  }
  return totals;
}

function extractParcelId(row) {
  const match = joinWords(row.cols.parcel).match(PARCEL_ID_RE);
  return match?.[0] ?? null;
}

function extractStub(row) {
  return row.cols.parcel.find((i) => /^\d+$/.test(i.str) && i.str.length >= 4)?.str ?? null;
}

function rowKind(row) {
  const parcelCol = joinWords(row.cols.parcel);
  if (PARCEL_ID_RE.test(parcelCol) && parcelCol.match(PARCEL_ID_RE)[0] === parcelCol)
    return "parcel_id";
  if (/^REAL$/i.test(parcelCol)) return "real";
  if (/^TOTAL:/i.test(parcelCol)) return "total";
  if (extractStub(row)) return "stub";
  if (!parcelCol) return "continuation";
  return "other";
}

function parseValueRow(row) {
  const items = row.raw.filter((i) => i.x >= 650 && i.x < 690);
  const amount = items.find((i) => /^[\d,]+$/.test(i.str))?.str;
  const type = items.find((i) => /^[LBT]$/.test(i.str))?.str;
  return { amount: parseMoney(amount), type };
}

function parseCertRow(row) {
  const text = joinWords(row.cols.cert);
  if (!text.includes("CERT DEL")) return null;
  const yearMatch = text.match(/(\d{4})\s+CERT\s+DEL/);
  const planMatch = joinWords(row.raw).match(/(\d+-PAY\s+[A-Z])/);
  return {
    cert_status: text.replace(/\*+/g, "").trim(),
    delinquent_year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    payment_plan: planMatch?.[1] ?? null,
  };
}

function parseParcelBlock(rows) {
  if (rows.length === 0) return null;

  const parcelId = extractParcelId((rows.find((r) => extractParcelId(r)) ?? rows[0]));
  if (!parcelId) return null;

  let stub = null;
  const ownerParts = [];
  const streetParts = [];
  const cszParts = [];
  const legalParts = [];
  let acres = null;
  let priorDelq = null;
  let landValue = null;
  let buildingValue = null;
  let totalValue = null;
  let certStatus = null;
  let delinquentYear = null;
  let paymentPlan = null;

  for (const row of rows) {
    const kind = rowKind(row);
    const nameAddr = joinWords(row.cols.name_address);
    const legal = joinWords(row.cols.legal);
    const cert = parseCertRow(row);

    if (kind === "parcel_id") continue;

    if (kind === "stub") {
      stub = extractStub(row) ?? stub;
      if (nameAddr && !isGarbage(nameAddr)) {
        const csz = parseCityStateZip(nameAddr);
        if (csz) cszParts.push(csz);
        else ownerParts.push(nameAddr);
      }
      if (legal && !isGarbage(legal)) legalParts.push(legal);
      const ac = joinWords(row.cols.acres).match(/[\d.]+/)?.[0];
      if (ac) acres = ac;
      const val = parseValueRow(row);
      if (val.type === "L") landValue = val.amount;
      if (cert) {
        certStatus = cert.cert_status;
        delinquentYear = cert.delinquent_year;
        paymentPlan = cert.payment_plan ?? paymentPlan;
      }
      continue;
    }

    if (kind === "real") {
      const pd = joinWords(row.cols.prior_delq);
      if (pd) priorDelq = parseMoney(pd);
      const val = parseValueRow(row);
      if (val.type === "B") buildingValue = val.amount;
      if (nameAddr && !isGarbage(nameAddr)) {
        if (looksLikeNameContinuation(nameAddr)) ownerParts.push(nameAddr);
        else if (looksLikeStreet(nameAddr)) streetParts.push(nameAddr);
        else ownerParts.push(nameAddr);
      }
      if (legal && !isGarbage(legal)) legalParts.push(legal);
      continue;
    }

    if (kind === "total") {
      const pd = joinWords(row.cols.prior_delq);
      if (pd) priorDelq = parseMoney(pd);
      const val = parseValueRow(row);
      if (val.type === "T") totalValue = val.amount;
      if (val.type === "B" && buildingValue == null) buildingValue = val.amount;
      if (val.type === "L" && landValue == null) landValue = val.amount;
      if (nameAddr && !isGarbage(nameAddr)) {
        const csz = parseCityStateZip(nameAddr);
        if (csz) cszParts.push(csz);
        else if (/^\d/.test(nameAddr)) streetParts.push(nameAddr);
        else cszParts.push(parseCityStateZip(nameAddr) ?? { city: nameAddr, state: null, zip: null });
      }
      if (legal && !isGarbage(legal)) legalParts.push(legal);
      if (cert) {
        certStatus = cert.cert_status;
        delinquentYear = cert.delinquent_year;
        paymentPlan = cert.payment_plan ?? paymentPlan;
      }
      continue;
    }

    if (kind === "continuation") {
      if (nameAddr && !isGarbage(nameAddr)) {
        const csz = parseCityStateZip(nameAddr);
        if (csz) cszParts.push(csz);
        else if (nameAddr.startsWith("&")) ownerParts.push(nameAddr);
        else streetParts.push(nameAddr);
      }
      if (legal && !isGarbage(legal)) legalParts.push(legal);
      if (cert) {
        certStatus = cert.cert_status;
        delinquentYear = cert.delinquent_year;
        paymentPlan = cert.payment_plan ?? paymentPlan;
      }
      const val = parseValueRow(row);
      if (val.type === "T" && totalValue == null) totalValue = val.amount;
      if (val.type === "B" && buildingValue == null) buildingValue = val.amount;
      if (val.type === "L" && landValue == null) landValue = val.amount;
    }
  }

  const ownerName = ownerParts.join(" ").replace(/\s+/g, " ").trim();
  const streetAddress = streetParts.join(" ").replace(/\s+/g, " ").trim();
  const csz = cszParts[cszParts.length - 1] ?? null;
  const city = csz?.city ?? null;
  const state = csz?.state ?? null;
  const zip = csz?.zip ?? null;

  const mailingAddress = [streetAddress, city, state, zip]
    .filter(Boolean)
    .join(", ")
    .replace(/,\s*,/g, ",")
    .trim();

  return {
    parcel_id: parcelId,
    stub,
    owner_name: ownerName,
    mailing_address: mailingAddress,
    street_address: streetAddress,
    city,
    state,
    zip,
    legal_description: legalParts.join(" ").replace(/\s+/g, " ").trim(),
    acres,
    prior_delq: priorDelq,
    land_value: landValue,
    building_value: buildingValue,
    total_value: totalValue,
    cert_status: certStatus,
    delinquent_year: delinquentYear,
    payment_plan: paymentPlan,
  };
}

function flushPending(pendingRows, district) {
  if (!district || pendingRows.length === 0) return;
  const parcel = parseParcelBlock(pendingRows);
  if (parcel) district.parcels.push(parcel);
}

async function parsePdf(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data }).promise;

  const districts = [];
  let currentDistrict = null;
  let pendingRows = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const rows = await extractPageRows(page);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      if (isPageHeaderRow(row)) continue;

      if (isDistrictHeaderRow(row)) {
        const d = parseDistrictHeader(row);
        if (d) {
          if (currentDistrict?.code !== d.code) {
            flushPending(pendingRows, currentDistrict);
            pendingRows = [];
            currentDistrict = { ...d, parcels: [], totals: null, page: pageNum };
            districts.push(currentDistrict);
          }
        }
        continue;
      }

      if (isDistrictFooterRow(row)) {
        flushPending(pendingRows, currentDistrict);
        pendingRows = [];
        if (currentDistrict) {
          currentDistrict.totals = parseDistrictTotals(rows, i);
        }
        continue;
      }

      const parcelId = extractParcelId(row);
      if (parcelId) {
        const pendingId = pendingRows.length
          ? extractParcelId(pendingRows.find((r) => extractParcelId(r)) ?? pendingRows[0])
          : null;

        if (pendingId === parcelId) {
          if (rowKind(row) !== "parcel_id") pendingRows.push(row);
          continue;
        }

        flushPending(pendingRows, currentDistrict);
        pendingRows = [row];
        continue;
      }

      if (pendingRows.length > 0) {
        pendingRows.push(row);
      }
    }
  }

  flushPending(pendingRows, currentDistrict);
  return districts;
}

function toCsv(parcels) {
  if (parcels.length === 0) return "";
  const headers = Object.keys(parcels[0]);
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [
    headers.join(","),
    ...parcels.map((p) => headers.map((h) => escape(p[h])).join(",")),
  ].join("\n");
}

function resolvePdfPath(argvPath) {
  if (argvPath && fs.existsSync(argvPath)) return argvPath;
  const p = paths();
  const discovered = findLatestTaxLienPdf(p.dataRoot);
  if (discovered) return discovered.path;
  const legacy = path.join(p.legacyRoot, "tax-lien-inbox");
  const legacyHit = findLatestTaxLienPdf(legacy);
  if (legacyHit) return legacyHit.path;
  return null;
}

async function main() {
  const argvPdf = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const pdfPath = resolvePdfPath(argvPdf);
  if (!pdfPath) {
    console.error("PDF not found. Options:");
    console.error("  1. Drop prosecutor cert PDF in data/counties/richland/inbox/");
    console.error("  2. npm run parse:tax-lien-list -- path/to/list.pdf");
    process.exit(1);
  }

  console.error(`Parsing ${pdfPath}...`);
  const districts = await parsePdf(pdfPath);

  const allParcels = districts.flatMap((d) =>
    d.parcels.map((p) => ({
      district_code: d.code,
      district_name: d.name,
      ...p,
    }))
  );

  const outDir = paths().dataRoot;
  fs.mkdirSync(path.join(outDir, "inbox"), { recursive: true });

  const baseName = outputBaseName(pdfPath);
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const csvPath = path.join(outDir, `${baseName}.csv`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      { source: pdfPath, generated_at: new Date().toISOString(), districts, parcel_count: allParcels.length },
      null,
      2
    )
  );
  fs.writeFileSync(csvPath, toCsv(allParcels));

  const withOwner = allParcels.filter((p) => p.owner_name).length;
  const withStreet = allParcels.filter((p) => p.street_address).length;
  const withCsz = allParcels.filter((p) => p.city).length;
  const totalDelq = allParcels.reduce((s, p) => s + (p.total_value ?? 0), 0);
  const matchedFooters = districts.filter(
    (d) => d.totals?.parcel_count != null && d.totals.parcel_count === d.parcels.length
  ).length;

  console.error(`Districts:       ${districts.length}`);
  console.error(`Parcels parsed:  ${allParcels.length}`);
  console.error(`Footer matches:  ${matchedFooters}/${districts.filter((d) => d.totals?.parcel_count != null).length} districts`);
  console.error(`With owner:      ${withOwner}`);
  console.error(`With street:     ${withStreet}`);
  console.error(`With city/state: ${withCsz}`);
  console.error(`Sum total value: $${totalDelq.toLocaleString()}`);
  console.error(`Wrote ${jsonPath}`);
  console.error(`Wrote ${csvPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

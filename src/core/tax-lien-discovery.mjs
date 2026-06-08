/**
 * @shared Discover the latest parsed tax lien cert list JSON in county data root.
 */

import fs from "fs";
import path from "path";

const TAX_LIEN_JSON_RE = /^tax-lien-list-(\d{2})-(\d{2})-(\d{4})\.json$/i;
const TAX_LIEN_PDF_RE = /(?:prosecutor|delinquent|tax.?lien|cert)/i;

function dateFromFilename(name) {
  const m = name.match(TAX_LIEN_JSON_RE);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * @param {string} dataRoot
 * @returns {{ path: string, date: string|null, filename: string }|null}
 */
export function findLatestTaxLienJson(dataRoot) {
  if (!dataRoot || !fs.existsSync(dataRoot)) return null;

  const candidates = [];
  for (const name of fs.readdirSync(dataRoot)) {
    if (!TAX_LIEN_JSON_RE.test(name)) continue;
    const full = path.join(dataRoot, name);
    if (!fs.statSync(full).isFile()) continue;
    candidates.push({
      path: full,
      filename: name,
      date: dateFromFilename(name),
      mtime: fs.statSync(full).mtimeMs,
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date);
    return b.mtime - a.mtime;
  });

  const best = candidates[0];
  return { path: best.path, date: best.date, filename: best.filename };
}

/**
 * Find newest prosecutor / delinquent land list PDF in county data root or inbox/.
 * @param {string} dataRoot
 * @returns {{ path: string, filename: string, mtime: number }|null}
 */
export function findLatestTaxLienPdf(dataRoot) {
  const dirs = [dataRoot, path.join(dataRoot, "inbox")].filter((d) => d && fs.existsSync(d));
  const candidates = [];

  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.pdf$/i.test(name)) continue;
      if (!TAX_LIEN_PDF_RE.test(name) && !/\d{1,2}-\d{1,2}-\d{4}/.test(name)) continue;
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      candidates.push({ path: full, filename: name, mtime: fs.statSync(full).mtimeMs });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

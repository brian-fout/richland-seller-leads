/**
 * @county richland — Map auditor condition/grade codes for comp classification.
 */

const POOR_CONDITION = new Set(["VP", "PR", "PO", "UN", "V-", "P-"]);
const FAIR_CONDITION = new Set(["FR"]);
const GOOD_CONDITION = new Set(["GD", "VG", "AV", "EX"]);

/** Grade strings from DWELL (e.g. C0, D-, E+). */
const POOR_GRADE_RE = /^[DE][+-]?0?$/i;
const FAIR_GRADE_RE = /^C[-]?0?$/i;

export function normalizeCity(city) {
  return String(city ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function isMansfieldCity(city) {
  const c = normalizeCity(city);
  return c === "MANSFIELD" || c.startsWith("MANSFIELD ");
}

export function resolveCondition(rec = {}, parcel = {}) {
  return rec.condition ?? parcel.condition ?? null;
}

export function resolveGrade(rec = {}, parcel = {}) {
  return rec.grade ?? parcel.grade ?? null;
}

export function isPoorConditionOrGrade(condition, grade) {
  const cond = condition ? String(condition).toUpperCase() : null;
  if (cond && (POOR_CONDITION.has(cond) || FAIR_CONDITION.has(cond))) return true;

  const g = grade ? String(grade).trim().toUpperCase() : null;
  if (g && (POOR_GRADE_RE.test(g) || FAIR_GRADE_RE.test(g))) return true;
  return false;
}

/**
 * Classify whether a sale looks like a retail / renovated transfer.
 * Strong price signals override stale auditor condition (common after flips).
 */
export function isRenovatedSale(price, ppsf, saleToAssessed, condition, grade, cfg = {}) {
  const minRetailPrice = cfg.minRetailPrice ?? 35000;
  const minRetailPpsf = cfg.minRetailPpsf ?? 35;
  const maxAsIsPrice = cfg.maxAsIsPrice ?? 28000;
  const maxAsIsPpsf = cfg.maxAsIsPpsf ?? 24;

  if (!ppsf || !price) return false;
  if (price <= maxAsIsPrice || ppsf <= maxAsIsPpsf) return false;

  if (price >= minRetailPrice && ppsf >= minRetailPpsf) return true;
  if (saleToAssessed != null && saleToAssessed >= 1.5 && price >= 30000) return true;

  if (isPoorConditionOrGrade(condition, grade)) return false;

  if (price >= minRetailPrice) return true;
  if (ppsf >= minRetailPpsf) return true;
  return false;
}

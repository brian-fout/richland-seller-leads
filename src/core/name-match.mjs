/** @shared Person/owner name normalization and fuzzy matching. */

export function clean(text) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOISE_WORDS = new Set([
  "JR",
  "SR",
  "II",
  "III",
  "IV",
  "UNK",
  "UNKNOWN",
  "HEIR",
  "HEIRS",
  "ADMIN",
  "ADMINISTRATOR",
  "EXECUTOR",
  "EXECUTORS",
  "ETAL",
  "ET",
  "AL",
  "ETC",
  "EST",
  "ESTATE",
  "TRUSTEE",
  "TR",
  "TENANT",
  "TENANTS",
  "OCCUPANT",
  "OCCUPANTS",
  "NKA",
  "AKA",
  "THE",
  "OF",
  "AND",
  "&",
]);

export function isGarbagePartyName(name) {
  const hay = clean(name).toUpperCase();
  if (!hay || hay.length < 3) return true;
  return (
    /^(UNK|UNKNOWN)\b/.test(hay) ||
    /\bTENANTS?\b/.test(hay) ||
    /\bOCCUPANTS?\b/.test(hay) ||
    /\bHEIRS?\b/.test(hay) ||
    /\bADMIN\b/.test(hay) ||
    /\bEXECUTORS?\b/.test(hay) ||
    /\bET\s*AL\b/.test(hay)
  );
}

/** Banks, courts, churches, government — not useful for GIS homeowner lookup. */
export function isInstitutionPartyName(name) {
  const hay = clean(name).toUpperCase();
  if (!hay || isGarbagePartyName(name)) return true;
  return (
    /\b(BANK|BANC|MORTGAGE|CREDIT UNION|SERVICING|TRUST COMPANY|NATIONAL ASSOCIATION|NA)\b/.test(hay) ||
    /\b(LLC|INC|CORP|LTD|LP|L\.P\.|LIMITED PARTNERSHIP|PARTNERSHIP)\b/.test(hay) ||
    /\b(COUNTY|COURT|CLERK|TREASURER|AUDITOR|PROSECUTOR|UNITED STATES|ATTORNEY)\b/.test(hay) ||
    /\b(CHURCH|TRUSTEE|TITLE|GUARANTY|GUARNTY|AUCTION|REAL ESTAT|COMMERCIAL)\b/.test(hay) ||
    /\b(FINANCIAL|FEDERAL|HOUSING|FINANCE|INVESTMENTS?)\b/.test(hay)
  );
}

export function splitPartyNames(text) {
  return clean(text)
    .split(/\s*;\s*/)
    .map((s) => clean(s))
    .filter(Boolean);
}

/** Person-like party names from a semicolon-delimited recorder/court field. */
export function personPartyNames(text) {
  return splitPartyNames(text).filter((n) => !isInstitutionPartyName(n));
}

export function normalizePersonName(name) {
  let s = clean(name).toUpperCase();
  if (!s) return "";

  if (s.includes(",")) {
    const parts = s.split(",").map((p) => clean(p)).filter(Boolean);
    if (parts.length >= 2) {
      s = `${parts[0]} ${parts.slice(1).join(" ")}`;
    }
  }

  return s
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function personNameTokens(name) {
  return normalizePersonName(name)
    .split(" ")
    .filter((t) => t.length > 1 && !NOISE_WORDS.has(t) && !/^\d+$/.test(t));
}

export function personNameMatchScore(a, b) {
  const ta = personNameTokens(a);
  const tb = personNameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const setB = new Set(tb);
  const overlap = ta.filter((t) => setB.has(t));
  if (overlap.length < 2) return 0;

  const lastA = ta[0];
  const lastB = tb[0];
  if (lastA !== lastB) return overlap.length * 10;

  return 50 + overlap.length * 15;
}

export function pickBestNameMatch(searchName, candidates, { minScore = 50 } = {}) {
  const scored = candidates
    .map((c) => ({ ...c, score: personNameMatchScore(searchName, c.owner_name ?? c.name ?? "") }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { status: "not_found", match: null, candidates: [] };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { status: "ambiguous", match: null, candidates: scored.slice(0, 5) };
  }
  return { status: "matched", match: scored[0], candidates: [] };
}

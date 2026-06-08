/**
 * @shared Load and query lead cards across one or many counties.
 * Each county stores data under data/counties/{id}/; this module merges at read time.
 */

import fs from "fs";
import path from "path";
import { countyPaths, DEFAULT_COUNTY, REPO_ROOT } from "./county-paths.mjs";
import { rankLeads } from "./lead-ranking.mjs";
import { filterActiveCards, loadSuppressions } from "./lead-suppressions.mjs";

const COUNTIES_DIR = path.join(REPO_ROOT, "data", "counties");

/** Counties with a lead-cards.json on disk. */
export function listActiveCounties() {
  const found = new Set();

  if (fs.existsSync(COUNTIES_DIR)) {
    for (const entry of fs.readdirSync(COUNTIES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = countyPaths(entry.name);
      if (fs.existsSync(p.leadCards)) found.add(entry.name);
    }
  }

  const legacy = countyPaths(DEFAULT_COUNTY);
  if (legacy.usesLegacyDataRoot && fs.existsSync(legacy.leadCards)) {
    found.add(DEFAULT_COUNTY);
  }

  return [...found].sort();
}

export function normalizeCity(city) {
  return String(city ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function filterByCity(cards, city) {
  if (!city) return cards;
  const want = normalizeCity(city);
  return cards.filter((c) => {
    const have = normalizeCity(c.city);
    return have === want || have.includes(want);
  });
}

export function filterByAgentReview(cards, { needsReview = false, offerReady = false } = {}) {
  if (needsReview) {
    return cards.filter((c) => c.needs_agent_review);
  }
  if (offerReady) {
    return cards.filter((c) => c.offer_ready);
  }
  return cards;
}

/**
 * @param {string} countyId
 * @returns {{ county_id: string, cards: object[], envelope: object|null, file: string|null }}
 */
export function loadCountyLeadCards(countyId) {
  const p = countyPaths(countyId);
  if (!fs.existsSync(p.leadCards)) {
    return { county_id: countyId, cards: [], envelope: null, file: null };
  }

  const envelope = JSON.parse(fs.readFileSync(p.leadCards, "utf8"));
  const rawCards = Array.isArray(envelope) ? envelope : (envelope.cards ?? []);
  const cards = rawCards.map((c) => ({
    ...c,
    county_id: c.county_id ?? countyId,
  }));

  return { county_id: countyId, cards, envelope: Array.isArray(envelope) ? null : envelope, file: p.leadCards };
}

/**
 * @param {object} [options]
 * @param {string[]} [options.counties] — subset; default all active counties
 * @param {string} [options.city] — e.g. Mansfield
 * @param {number} [options.limit] — max rows after rank
 * @param {boolean} [options.rerank=true] — re-score merged set with shared rankLeads()
 * @param {boolean} [options.includeDismissed=false] — include manually dismissed parcels
 * @param {boolean} [options.needsReview=false] — only leads awaiting agent verdict
 * @param {boolean} [options.offerReady=false] — only agent-approved pursue leads
 */
export function loadAllLeadCards(options = {}) {
  const { city, limit, rerank = true, includeDismissed = false, needsReview = false, offerReady = false } =
    options;
  let countyIds = options.counties?.length ? [...options.counties] : listActiveCounties();

  if (!countyIds.length) {
    return { counties: [], sources: [], cards: [], total_before_limit: 0 };
  }

  const sources = [];
  let cards = [];

  let dismissedExcluded = 0;

  for (const id of countyIds) {
    const loaded = loadCountyLeadCards(id);
    if (!loaded.cards.length) continue;

    let countyCards = loaded.cards;
    if (!includeDismissed) {
      const suppressions = loadSuppressions(countyPaths(id).leadSuppressions);
      const before = countyCards.length;
      countyCards = filterActiveCards(countyCards, suppressions);
      dismissedExcluded += before - countyCards.length;
    }

    if (countyCards.length) {
      sources.push({ county_id: id, count: countyCards.length, file: loaded.file });
      cards.push(...countyCards);
    }
  }

  cards = filterByCity(cards, city);
  cards = filterByAgentReview(cards, { needsReview, offerReady });

  if (rerank) {
    cards = rankLeads(cards);
  }

  const totalBeforeLimit = cards.length;
  if (limit != null && limit > 0) {
    cards = cards.slice(0, limit);
  }

  return {
    counties: countyIds,
    sources,
    cards,
    total_before_limit: totalBeforeLimit,
    dismissed_excluded: dismissedExcluded,
  };
}

/** Row shape for agent weekly review CSV export. */
export function agentReviewRow(card) {
  const slim = slimLeadRow(card);
  const arv = card.arv ?? {};
  return {
    ...slim,
    condition: card.condition ?? null,
    condition_label: card.condition_label ?? null,
    grade: card.grade ?? null,
    square_footage: card.square_footage ?? null,
    total_value: card.total_value ?? card.auditor?.total_appraised_value ?? null,
    prior_delq: card.prior_delq ?? card.property?.tax_lien?.prior_delq ?? null,
    contact_owner: card.contact_owner ?? null,
    mailing_address: card.mailing_address ?? null,
    arv_confidence_score: arv.confidence?.score ?? null,
    arv_trustworthy: arv.trustworthy_for_wholesale ?? false,
    agent_rehab_estimate: card.agent_rehab_estimate ?? null,
    review_prompt: slim.needs_agent_review
      ? "npm run agent:feedback -- --parcel " + card.parcel_id + ' --text "your notes..."'
      : null,
  };
}

export function slimLeadRow(card) {
  const arv = card.arv ?? {};
  const arvMostLikely =
    arv.most_likely_arv ??
    arv.marketing_arv?.price ??
    arv.arv?.mid ??
    arv.mid ??
    null;

  const agent = card.agent_calibration ?? null;
  const effectiveArv = card.effective_arv ?? arvMostLikely;

  return {
    rank: card.rank,
    county_id: card.county_id,
    city: card.city ?? null,
    address: card.address ?? card.beacon?.parcel_address ?? null,
    parcel_id: card.parcel_id,
    sources: card.sources ?? [],
    source_count: card.source_count ?? (card.sources?.length ?? 0),
    rank_score: card.rank_score,
    safe_to_contact: card.safe_to_contact ?? null,
    arv_most_likely: arvMostLikely,
    effective_arv: effectiveArv,
    arv_source: card.arv_source ?? "model",
    arv_confidence: arv.confidence?.level ?? null,
    agent_arv: agent?.agent_arv ?? agent?.agent_arv_range?.high ?? null,
    agent_offer_max: card.agent_offer_max ?? agent?.agent_offer_max ?? null,
    agent_verdict: agent?.agent_verdict ?? null,
    needs_agent_review: card.needs_agent_review ?? false,
    offer_ready: card.offer_ready ?? false,
    agent_drift_pct: card.agent_model_compare?.delta_pct ?? null,
  };
}

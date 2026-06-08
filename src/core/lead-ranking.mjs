/** @shared Lead scoring and ranking — vacant land kept but deprioritized. */

function parseDistressDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const d = new Date(text.slice(0, 10));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function latestDistressFileDate(card) {
  let latest = null;
  for (const recs of Object.values(card.records ?? {})) {
    for (const rec of recs) {
      const d = parseDistressDate(rec.file_date);
      if (d && (!latest || d > latest)) latest = d;
    }
  }
  return latest;
}

function monthsSince(date) {
  if (!date) return null;
  const now = new Date();
  return (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
}

export function isVacantLandLead(card) {
  if (card?.likely_vacant_land) return true;
  if (card?.has_improvements) return false;
  const bldg = card?.building_value ?? card?.auditor?.building_value;
  const land = card?.land_value ?? card?.auditor?.land_value;
  return (bldg == null || bldg === 0) && land != null && land > 0;
}

const SOURCE_WEIGHTS = {
  "sheriff-sales": 40,
  "clerk-foreclosures": 35,
  "lis-pendens": 25,
  "tax-liens": 30,
  "probate-estates": 20,
  "code-violations": 20,
  evictions: 15,
};

/** Higher score = higher priority. Vacant land capped near bottom via large penalty. */
export function scoreLead(card) {
  const factors = [];
  let score = 0;

  if (isVacantLandLead(card)) {
    factors.push({ factor: "vacant_land", delta: -500, note: "Vacant land — deprioritized" });
    score -= 500;
  } else {
    factors.push({ factor: "improved_property", delta: 40 });
    score += 40;
  }

  const multiBonus = Math.max(0, (card.source_count ?? 1) - 1) * 25;
  if (multiBonus > 0) {
    factors.push({ factor: "multi_source", delta: multiBonus, source_count: card.source_count });
    score += multiBonus;
  }

  for (const src of card.sources ?? []) {
    const w = SOURCE_WEIGHTS[src] ?? 10;
    factors.push({ factor: `source:${src}`, delta: w });
    score += w;
  }

  if (card.safe_to_contact) {
    factors.push({ factor: "safe_to_contact", delta: 20 });
    score += 20;
  }

  const delq = card.prior_delq ?? card.property?.tax_lien?.prior_delq;
  if (delq > 0) {
    const delqBonus = Math.min(30, Math.round(delq / 500));
    factors.push({ factor: "tax_delinquency", delta: delqBonus, amount: delq });
    score += delqBonus;
  }

  const certDelq = card.cert_prior_delq ?? card.property?.tax_lien?.prior_delq ?? null;
  const chargeDelq = card.delinquency_source === "charge_dat" ? card.prior_delq : null;
  if (chargeDelq > 0 && certDelq > 0) {
    const drift = Math.abs(chargeDelq - certDelq) / Math.max(certDelq, 1);
    if (drift <= 0.15) {
      factors.push({ factor: "charge_cert_agree", delta: 12, charge: chargeDelq, cert: certDelq });
      score += 12;
    } else if (drift >= 0.5) {
      factors.push({ factor: "charge_cert_diverge", delta: -8, charge: chargeDelq, cert: certDelq });
      score -= 8;
    }
  } else if (chargeDelq > 0 && card.delinquency_source === "charge_dat") {
    factors.push({ factor: "charge_delinquent_live", delta: 8, amount: chargeDelq });
    score += 8;
  }

  const latestFile = latestDistressFileDate(card);
  const monthsAgo = monthsSince(latestFile);
  if (monthsAgo != null) {
    if (monthsAgo <= 6) {
      factors.push({ factor: "distress_recent_6mo", delta: 25, months_ago: monthsAgo });
      score += 25;
    } else if (monthsAgo <= 18) {
      factors.push({ factor: "distress_recent_18mo", delta: 12, months_ago: monthsAgo });
      score += 12;
    } else if (monthsAgo > 36) {
      factors.push({ factor: "distress_stale_36mo", delta: -15, months_ago: monthsAgo });
      score -= 15;
    }
  }

  const city = String(card.city ?? "").toUpperCase();
  if (city === "MANSFIELD" || city.includes("MANSFIELD")) {
    factors.push({ factor: "city_mansfield", delta: 10 });
    score += 10;
  }

  const arv = card.arv;
  if (arv?.trustworthy_for_wholesale) {
    factors.push({ factor: "arv_trustworthy", delta: 25 });
    score += 25;
  } else if (arv?.review_required) {
    factors.push({ factor: "arv_needs_review", delta: -15 });
    score -= 15;
  }

  const arvConf = arv?.confidence?.score;
  if (arvConf) {
    const arvBonus = Math.round(arvConf * 15);
    factors.push({ factor: "arv_confidence", delta: arvBonus });
    score += arvBonus;
  }

  const arvMid = card.effective_arv ?? arv?.most_likely_arv ?? arv?.mid ?? null;
  const valueAnchor = card.total_value ?? card.auditor?.total_appraised_value ?? null;
  if (arvMid > 0 && valueAnchor > 0) {
    const spread = arvMid - valueAnchor;
    const spreadPct = spread / arvMid;
    if (spreadPct >= 0.3) {
      const marginBonus = Math.min(25, Math.round(spreadPct * 40));
      factors.push({ factor: "arv_value_spread", delta: marginBonus, spread_pct: Math.round(spreadPct * 100) });
      score += marginBonus;
    } else if (spreadPct < 0.1) {
      factors.push({ factor: "arv_thin_spread", delta: -10, spread_pct: Math.round(spreadPct * 100) });
      score -= 10;
    }
  }

  const agent = card.agent_calibration;
  if (agent?.agent_verdict === "pursue") {
    factors.push({ factor: "agent_verdict_pursue", delta: 35 });
    score += 35;
  } else if (agent?.agent_verdict === "pass") {
    factors.push({ factor: "agent_verdict_pass", delta: -80 });
    score -= 80;
  } else if (agent?.agent_verdict === "maybe") {
    factors.push({ factor: "agent_verdict_maybe", delta: -10 });
    score -= 10;
  }

  if (agent?.agent_offer_max != null) {
    const offerBonus = Math.min(20, Math.round(agent.agent_offer_max / 5000));
    factors.push({ factor: "agent_offer_max", delta: offerBonus, offer_max: agent.agent_offer_max });
    score += offerBonus;
  }

  if (card.needs_agent_review) {
    const trustworthy = Boolean(arv?.trustworthy_for_wholesale);
    const penalty = trustworthy ? -55 : -35;
    factors.push({
      factor: "needs_agent_review",
      delta: penalty,
      trustworthy_arv: trustworthy,
      note: "Model ARV without agent verdict — deprioritize until agent:feedback",
    });
    score += penalty;
  }

  if (card.offer_ready) {
    factors.push({ factor: "offer_ready", delta: 30 });
    score += 30;
  }

  if (agent?.agent_arv != null && arv?.most_likely_arv != null) {
    const driftPct = Math.abs(agent.agent_arv - arv.most_likely_arv) / arv.most_likely_arv;
    if (driftPct <= 0.1) {
      factors.push({ factor: "agent_arv_confirms_model", delta: 15, drift_pct: Math.round(driftPct * 100) });
      score += 15;
    } else if (driftPct > 0.2) {
      factors.push({ factor: "agent_arv_disagrees_model", delta: -20, drift_pct: Math.round(driftPct * 100) });
      score -= 20;
    }
  }

  return { rank_score: score, rank_factors: factors };
}

export function rankLeads(cards) {
  const scored = cards.map((card) => {
    const { rank_score, rank_factors } = scoreLead(card);
    return { ...card, rank_score, rank_factors };
  });

  scored.sort(
    (a, b) =>
      b.rank_score - a.rank_score ||
      b.source_count - a.source_count ||
      (b.prior_delq ?? 0) - (a.prior_delq ?? 0) ||
      a.parcel_id.localeCompare(b.parcel_id)
  );

  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }
  return scored;
}

export function vacantLandRankSummary(cards) {
  const vacant = cards.filter(isVacantLandLead);
  if (!vacant.length) return { vacant_count: 0, bottom_quartile: 0, median_rank: null };
  const ranks = vacant.map((c) => c.rank).filter((r) => r != null);
  ranks.sort((a, b) => a - b);
  const bottomQuartileStart = Math.ceil(cards.length * 0.75);
  const inBottomQuartile = ranks.filter((r) => r >= bottomQuartileStart).length;
  return {
    vacant_count: vacant.length,
    bottom_quartile: inBottomQuartile,
    median_rank: ranks[Math.floor(ranks.length / 2)] ?? null,
    lowest_rank: ranks[0] ?? null,
    highest_rank: ranks[ranks.length - 1] ?? null,
  };
}

/**
 * @shared Agent-authoritative ARV layer — conservative retail for offers.
 */

import { compareAgentToModel } from "./agent-feedback.mjs";

export function agentArvMid(agent) {
  if (!agent) return null;
  return agent.agent_arv ?? agent.agent_arv_range?.high ?? agent.agent_arv_range?.low ?? null;
}

/**
 * Conservative effective ARV: when agent weighed in, cap model at agent value.
 */
export function computeEffectiveArv(card) {
  const arv = card.arv ?? {};
  const modelArv = arv.most_likely_arv ?? arv.marketing_arv?.price ?? arv.mid ?? null;
  const agent = card.agent_calibration ?? null;
  const agentArv = agentArvMid(agent);
  const agentOfferMax = agent?.agent_offer_max ?? null;

  let effectiveArv = modelArv;
  let arv_source = "model";

  if (agentArv != null && modelArv != null) {
    effectiveArv = Math.min(modelArv, agentArv);
    arv_source = agentArv < modelArv ? "agent_cap" : agentArv > modelArv ? "model" : "agent_model_agree";
  } else if (agentArv != null) {
    effectiveArv = agentArv;
    arv_source = "agent";
  }

  const agentVerdict = agent?.agent_verdict ?? null;
  const hasTrustworthyModel = Boolean(arv.trustworthy_for_wholesale ?? arv.confidence?.trustworthy_for_wholesale);
  const needs_agent_review = hasTrustworthyModel && !agentVerdict && effectiveArv != null;
  const offer_ready =
    effectiveArv != null && agentVerdict === "pursue" && !needs_agent_review;

  return {
    model_arv: modelArv,
    agent_arv: agentArv,
    agent_offer_max: agentOfferMax,
    effective_arv: effectiveArv,
    arv_source,
    agent_verdict: agentVerdict,
    needs_agent_review,
    offer_ready,
  };
}

/** Attach effective ARV fields and refresh agent_model_compare after ARV merge. */
export function applyAgentArvLayer(card) {
  const layer = computeEffectiveArv(card);
  const modelArv = layer.model_arv;
  const agent = card.agent_calibration ?? null;
  return {
    ...card,
    effective_arv: layer.effective_arv,
    arv_source: layer.arv_source,
    agent_offer_max: layer.agent_offer_max ?? agent?.agent_offer_max ?? null,
    agent_rehab_estimate: agent?.agent_rehab_estimate ?? null,
    needs_agent_review: layer.needs_agent_review,
    offer_ready: layer.offer_ready,
    agent_model_compare: compareAgentToModel(agent, modelArv),
    arv_layer: layer,
  };
}

/**
 * @county richland — Merge distress records + property profiles into unified lead cards.
 *
 * Prerequisites:
 *   npm run link:leads
 *   npm run enrich:property-profiles
 *
 * Usage: npm run build:lead-cards
 *
 * Dismissed parcels (lead-suppressions.jsonl) are excluded unless new distress
 * list activity appears since dismiss — then they auto-reinstate.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { paths, getActiveCounty } from "../src/core/county-context.mjs";
import { buildAllClusters } from "./link-leads.mjs";
import { loadBeaconCache } from "./beacon-enrich-lib.mjs";
import { resolveOwnerContact } from "./owner-contact.mjs";
import { isVacantLandLead, rankLeads, vacantLandRankSummary } from "./lead-ranking.mjs";
import {
  applyDistressReinstatements,
  buildOwnerSnapshots,
  detectOwnerChanges,
  filterActiveCards,
  loadOwnerSnapshots,
  loadSuppressions,
  saveOwnerSnapshots,
  saveSuppressions,
} from "../src/core/lead-suppressions.mjs";
import {
  compareAgentToModel,
  loadAgentCalibration,
} from "../src/core/agent-feedback.mjs";

const p = paths();
const PROFILES_BY_PARCEL = p.propertyProfilesByParcel;
const AUDITOR_OVERLAY = p.parcelOverlay;
const COMP_INDEX_AUDITOR = p.compIndexAuditor;
const CARDS_JSON = p.leadCards;

function loadPropertyProfiles() {
  if (!fs.existsSync(PROFILES_BY_PARCEL)) {
    throw new Error(`Missing ${PROFILES_BY_PARCEL}. Run: npm run enrich:property-profiles`);
  }
  return JSON.parse(fs.readFileSync(PROFILES_BY_PARCEL, "utf8"));
}

function loadAuditorOverlay() {
  if (!fs.existsSync(AUDITOR_OVERLAY)) return {};
  return JSON.parse(fs.readFileSync(AUDITOR_OVERLAY, "utf8"));
}

function loadAuditorCompByParcel() {
  const map = new Map();
  if (!fs.existsSync(COMP_INDEX_AUDITOR)) return map;
  for (const line of fs.readFileSync(COMP_INDEX_AUDITOR, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.parcel_id) map.set(rec.parcel_id, rec);
  }
  return map;
}

function applyAuditorAttributes(card, auditorRec) {
  if (!auditorRec) return card;
  const useDwell = auditorRec.building_attributes_source === "dwelling_dat";
  return {
    ...card,
    address: auditorRec.address ?? card.address,
    land_value: auditorRec.auditor_land_value ?? auditorRec.land_value ?? card.land_value,
    building_value: auditorRec.auditor_building_value ?? auditorRec.building_value ?? card.building_value,
    total_value:
      auditorRec.auditor_total_appraised_value ??
      auditorRec.total_appraised_value ??
      card.total_value,
    square_footage: auditorRec.square_footage ?? card.square_footage,
    year_built: auditorRec.year_built ?? card.year_built,
    bedrooms: auditorRec.bedrooms ?? card.bedrooms ?? null,
    full_bath: auditorRec.full_bath ?? card.full_bath ?? null,
    half_bath: auditorRec.half_bath ?? card.half_bath ?? null,
    style: auditorRec.style ?? card.style ?? null,
    grade: auditorRec.grade ?? card.grade ?? null,
    stories: auditorRec.stories ?? card.stories ?? null,
    prior_delq:
      auditorRec.prior_delinquent ??
      card.prior_delq,
    delinquency_source: auditorRec.delinquency_source ?? card.delinquency_source ?? null,
    net_delinquency_due: auditorRec.net_delinquency_due ?? card.net_delinquency_due ?? null,
    charge_delinquent: auditorRec.charge_delinquent ?? card.charge_delinquent ?? false,
    cert_prior_delq: card.property?.tax_lien?.prior_delq ?? card.cert_prior_delq ?? null,
    neighborhood: auditorRec.neighborhood ?? card.neighborhood ?? null,
    mailing_address: auditorRec.auditor_mailing_address ?? card.mailing_address ?? null,
    mailing_street: auditorRec.auditor_mailing_street ?? card.mailing_street ?? null,
    mailing_city: auditorRec.auditor_mailing_city ?? card.mailing_city ?? null,
    mailing_state: auditorRec.auditor_mailing_state ?? card.mailing_state ?? null,
    mailing_zip: auditorRec.auditor_mailing_zip ?? card.mailing_zip ?? null,
    last_sale_date: auditorRec.auditor_sale_date ?? auditorRec.sale_date ?? card.last_sale_date,
    last_sale_price: auditorRec.auditor_sale_price ?? auditorRec.sale_price ?? card.last_sale_price,
    building_attributes_source: useDwell
      ? "dwelling_dat"
      : card.building_attributes_source ?? auditorRec.building_attributes_source ?? null,
  };
}

function pickAuditorAddress(cluster, profile) {
  const cama = profile?.cama_raw ?? {};
  return (
    cluster.address ??
    cama.PARCEL_ADDRESS ??
    cama.LEGAL_ADDRESS ??
    profile?.tax_lien?.street_address ??
    null
  );
}

function pickAuditorCity(cluster, profile) {
  const cama = profile?.cama_raw ?? {};
  const legalCity = cama.LEGAL_CITY ?? null;
  return cluster.city ?? profile?.tax_lien?.city ?? legalCity ?? null;
}

function buildCard(cluster, profile) {
  const hints = profile?.hints ?? {};
  const property = profile
    ? {
        fetch_status: profile.fetch_status ?? null,
        fetched_at: profile.fetched_at ?? null,
        error: profile.error ?? null,
        cama_raw: profile.cama_raw ?? null,
        auditor_values: profile.auditor_values ?? null,
        tax_lien: profile.tax_lien ?? null,
        hints,
      }
    : null;

  return {
    parcel_id: cluster.parcel_id,
    source_count: cluster.source_count,
    sources: cluster.sources,
    record_count: cluster.record_count,
    address: pickAuditorAddress(cluster, profile),
    city: pickAuditorCity(cluster, profile),
    address_source: cluster.address_source ?? null,
    land_use_code: hints.land_use_code ?? profile?.cama_raw?.LAND_USE_CODE ?? null,
    land_value: hints.land_value ?? null,
    building_value: hints.building_value ?? null,
    total_value: hints.total_value ?? null,
    acres: hints.acres ?? profile?.cama_raw?.CALCULATED_ACRES ?? null,
    square_footage: hints.square_footage ?? profile?.cama_raw?.TOTAL_LIVING_AREA ?? null,
    year_built: profile?.cama_raw?.YEAR_BUILT ?? null,
    last_sale_date: profile?.cama_raw?.SALES_DATE ?? null,
    last_sale_price: profile?.cama_raw?.SALES_PRICE ?? null,
    likely_vacant_land: hints.likely_vacant_land ?? false,
    has_improvements: hints.has_improvements ?? false,
    prior_delq: profile?.tax_lien?.prior_delq ?? null,
    delinquent_year: profile?.tax_lien?.delinquent_year ?? null,
    cert_status: profile?.tax_lien?.cert_status ?? null,
    records: cluster.records,
    property,
  };
}

function summarizeCards(cards) {
  return {
    total: cards.length,
    multi_source: cards.filter((c) => c.source_count >= 2).length,
    with_property_profile: cards.filter((c) => c.property?.fetch_status === "ok").length,
    property_not_found: cards.filter((c) => c.property?.fetch_status === "not_found").length,
    property_error: cards.filter((c) => c.property?.fetch_status === "error").length,
    likely_vacant_land: cards.filter((c) => c.likely_vacant_land).length,
    has_improvements: cards.filter((c) => c.has_improvements).length,
    with_tax_lien: cards.filter((c) => c.property?.tax_lien).length,
    safe_to_contact: cards.filter((c) => c.safe_to_contact).length,
    needs_owner_verification: cards.filter((c) => !c.safe_to_contact).length,
    beacon_verified: cards.filter((c) => c.contact_owner_source === "beacon").length,
    auditor_cama_owner: cards.filter((c) => c.contact_owner_source === "auditor_cama").length,
    cert_list_owner: cards.filter((c) => c.contact_owner_source === "tax_lien_cert").length,
    gis_owner_stale: cards.filter((c) => c.gis_owner_stale).length,
  };
}

function main() {
  const countyId = getActiveCounty();
  const { allClusters } = buildAllClusters();
  const profilesByParcel = loadPropertyProfiles();
  const beaconCache = loadBeaconCache();
  const auditorOverlay = loadAuditorOverlay();
  const auditorCompByParcel = loadAuditorCompByParcel();
  const agentCalibration = loadAgentCalibration(p.agentCalibration);

  const allCards = allClusters.map((cluster) => {
    const profile = profilesByParcel[cluster.parcel_id] ?? null;
    const beacon = beaconCache.get(cluster.parcel_id) ?? null;
    const auditor = auditorOverlay[cluster.parcel_id] ?? null;
    const auditorComp = auditorCompByParcel.get(cluster.parcel_id) ?? null;
    let card = buildCard(cluster, profile);
    card = applyAuditorAttributes(card, auditorComp);
    const ownerFields = resolveOwnerContact({ cluster, profile, beacon, auditor, auditorComp });
    const auditorSale =
      auditor?.sale_date && auditor?.sale_price != null
        ? { date: auditor.sale_date, price: auditor.sale_price }
        : null;
    const beaconValidSale = beacon?.sales?.find((s) => /valid sale/i.test(s.validity ?? ""));

    return {
      ...card,
      county_id: countyId,
      ...ownerFields,
      ...(auditor
        ? {
            auditor: {
              owner_name: auditor.owner_name ?? null,
              sale_date: auditor.sale_date ?? null,
              sale_price: auditor.sale_price ?? null,
              land_value: auditor.land_value ?? null,
              building_value: auditor.building_value ?? null,
              total_appraised_value: auditor.total_appraised_value ?? null,
            },
          }
        : {}),
      ...(beacon?.status === "ok"
        ? {
            beacon: {
              owner_name: beacon.owner_name ?? null,
              mailing_address: beacon.mailing_address ?? null,
              parcel_address: beacon.parcel_address ?? null,
              valuation: beacon.valuation ?? {},
              sales: beacon.sales ?? [],
              source_url: beacon.source_url ?? null,
              fetched_at: beacon.fetched_at ?? null,
            },
          }
        : {}),
      last_sale_date: beaconValidSale?.date ?? auditorSale?.date ?? card.last_sale_date,
      last_sale_price: beaconValidSale?.price ?? auditorSale?.price ?? card.last_sale_price,
    };
  }).map((card) => {
    const agent = agentCalibration.by_parcel?.[card.parcel_id] ?? null;
    if (!agent) return card;
    const modelArv = card.arv?.most_likely_arv ?? card.arv?.mid ?? null;
    return {
      ...card,
      agent_calibration: agent,
      agent_model_compare: compareAgentToModel(agent, modelArv),
    };
  });

  const suppressions = loadSuppressions(p.leadSuppressions);
  const clustersByParcel = new Map(allClusters.map((c) => [c.parcel_id, c]));
  const { reinstated } = applyDistressReinstatements(suppressions, clustersByParcel);
  if (reinstated.length) {
    saveSuppressions(p.leadSuppressions, suppressions);
    for (const row of reinstated) {
      fs.appendFileSync(p.leadReinstatements, `${JSON.stringify(row)}\n`);
    }
  }

  const priorSnapshots = loadOwnerSnapshots(p.leadOwnerSnapshots);
  const staleCandidates = detectOwnerChanges(allCards, priorSnapshots, suppressions);

  const suppressedCount = allCards.filter((c) => suppressions.has(c.parcel_id)).length;
  const activeCards = filterActiveCards(allCards, suppressions);
  const cards = rankLeads(activeCards);
  const missingProfiles = cards.filter((c) => !profilesByParcel[c.parcel_id]).length;
  const stats = summarizeCards(cards);
  const vacantRank = vacantLandRankSummary(cards);

  const ownerSnapshots = {
    ...priorSnapshots,
    ...buildOwnerSnapshots(activeCards, suppressions),
  };
  saveOwnerSnapshots(p.leadOwnerSnapshots, ownerSnapshots);

  const staleOutput = {
    county_id: countyId,
    generated_at: new Date().toISOString(),
    count: staleCandidates.length,
    hint: "Dismiss with: npm run dismiss:lead -- --dismiss-stale  (or dismiss individually)",
    candidates: staleCandidates,
  };
  fs.writeFileSync(p.leadStaleCandidates, JSON.stringify(staleOutput, null, 2));

  const output = {
    county_id: countyId,
    generated_at: new Date().toISOString(),
    ranking: {
      sorted_by: "rank_score desc",
      vacant_land_deprioritized: true,
      vacant_land: vacantRank,
    },
    suppressions: {
      file: p.leadSuppressions,
      active_dismissed: suppressedCount,
      reinstated_this_build: reinstated.length,
      stale_owner_candidates: staleCandidates.length,
    },
    stats: {
      ...stats,
      missing_property_profiles: missingProfiles,
      total_before_suppressions: allCards.length,
      suppressed_excluded: suppressedCount,
    },
    cards,
  };

  fs.writeFileSync(CARDS_JSON, JSON.stringify(output, null, 2));

  console.error("Lead cards built");
  const reinstateNote = reinstated.length ? `, ${reinstated.length} reinstated` : "";
  console.error(
    `  Total cards:           ${stats.total} (${suppressedCount} dismissed, ${staleCandidates.length} stale owner${reinstateNote})`
  );
  if (reinstated.length) {
    for (const row of reinstated) {
      console.error(
        `  Reinstated ${row.parcel_id} — new distress: ${(row.new_sources.length ? row.new_sources.join("+") : row.new_records.join(", "))}`
      );
    }
  }
  console.error(`  Multi-source:          ${stats.multi_source}`);
  console.error(`  CAMA profiles OK:      ${stats.with_property_profile}`);
  console.error(`  CAMA not found:        ${stats.property_not_found}`);
  console.error(`  CAMA errors:           ${stats.property_error}`);
  console.error(`  Likely vacant land:    ${stats.likely_vacant_land}`);
  console.error(`  Vacant median rank:    ${vacantRank.median_rank ?? "n/a"} / ${stats.total}`);
  console.error(`  Has improvements:      ${stats.has_improvements}`);
  console.error(`  Safe to contact:       ${stats.safe_to_contact}`);
  console.error(`  Needs verification:    ${stats.needs_owner_verification}`);
  console.error(`  Beacon verified:       ${stats.beacon_verified}`);
  console.error(`  Auditor CAMA owner:    ${stats.auditor_cama_owner}`);
  console.error(`  Cert list owner:       ${stats.cert_list_owner}`);
  console.error(`  GIS owner stale:       ${stats.gis_owner_stale}`);
  console.error(`  Missing profiles:      ${missingProfiles}`);
  console.error("");
  console.error(`Wrote ${CARDS_JSON}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();

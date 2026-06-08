/**
 * Registry of Richland-only scripts (still under scripts/ until fully moved).
 * Use this list to know what must be reimplemented per new county.
 */

export const RICHLAND_SCRIPTS = {
  cama: [
    "scripts/download-auditor-cama.mjs",
    "scripts/import-auditor-cama.mjs",
    "scripts/build-sales-events.mjs",
    "scripts/auditor-cama-dat.mjs",
    "scripts/auditor-cama.mjs",
    "scripts/pull-county-parcels.mjs",
    "scripts/auditor-gis.mjs",
  ],
  beacon: [
    "scripts/beacon-parcel.mjs",
    "scripts/beacon-enrich-lib.mjs",
    "scripts/enrich-from-beacon.mjs",
    "scripts/beacon-save-session.mjs",
    "scripts/beacon-wait-then-county.mjs",
  ],
  scrapers: [
    "scripts/parse-tax-lien-list.mjs",
    "scripts/scrape-lis-pendens.mjs",
    "scripts/scrape-pre-foreclosure.mjs",
    "scripts/scrape-evictions.mjs",
    "scripts/scrape-code-violations.mjs",
    "scripts/scrape-probate-estates.mjs",
    "scripts/scrape-clerk-foreclosures.mjs",
    "scripts/scrape-all.mjs",
  ],
  enrich: [
    "scripts/enrich-probate-addresses.mjs",
    "scripts/enrich-clerk-foreclosures.mjs",
    "scripts/enrich-parcel-ids.mjs",
    "scripts/enrich-property-profiles.mjs",
  ],
  leads: [
    "scripts/link-leads.mjs",
    "scripts/build-lead-cards.mjs",
    "scripts/tax-lien-index.mjs",
  ],
  clerk: [
    "scripts/clerk-session.mjs",
    "scripts/clerk-detail.mjs",
    "scripts/clerk-search.mjs",
    "scripts/clerk-save-session.mjs",
    "scripts/clerk-captcha.mjs",
  ],
  probate: [
    "scripts/probate-session.mjs",
    "scripts/probate-detail.mjs",
    "scripts/probate-captcha.mjs",
  ],
};

export const SHARED_SCRIPTS = {
  arv: [
    "scripts/estimate-arv.mjs",
    "scripts/estimate-arv-weighted.mjs",
    "scripts/batch-estimate-arv.mjs",
    "scripts/test-arv-engine.mjs",
    "src/arv/arvEngine.js",
    "src/arv/countyAdapter.js",
  ],
  core: [
    "src/core/county-paths.mjs",
    "src/core/county-context.mjs",
    "src/core/lead-ranking.mjs",
    "src/core/name-match.mjs",
    "src/core/owner-contact.mjs",
    "scripts/scrape-state.mjs",
    "scripts/lead-ranking.mjs",
    "scripts/query-leads.mjs",
    "scripts/migrate-data-to-counties.mjs",
    "src/core/platform-leads.mjs",
    "scripts/owner-contact.mjs",
    "scripts/name-match.mjs",
  ],
  docs: ["docs/ARCHITECTURE.md", "scripts/README.md", "scripts/richland/README.md", "scripts/arv/README.md"],
};

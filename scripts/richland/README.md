# Richland County scripts

These scripts are **Richland-only**. They depend on Richland GIS, Google Drive CAMA exports (Ohio AA407), Beacon AppID 1067, Kofile recorder, and local court sites.

**Authoritative list:** `src/counties/richland/manifest.mjs`  
**URLs & IDs:** `src/counties/richland/config.mjs`

Scripts still live under `scripts/` (not this folder) during migration. Look for `@county richland` in the file header.

## CAMA & parcels

| npm script | Script | Purpose |
|------------|--------|---------|
| `pull:county-parcels` | `pull-county-parcels.mjs` | GIS Parcel_CAMA → comp-index |
| `download:auditor-cama` | `download-auditor-cama.mjs` | Google Drive .DAT files |
| `import:auditor-cama` | `import-auditor-cama.mjs` | OWNDATMAX, ASMT, DWELL, SALES overlay |
| `build:sales-events` | `build-sales-events.mjs` | SALES.DAT → sales-events.jsonl |

Parsers: `auditor-cama-dat.mjs` (Ohio AA407 fixed-width)

## Distress scrapers

| npm script | Script |
|------------|--------|
| `parse:tax-lien-list` | `parse-tax-lien-list.mjs` |
| `scrape:lis-pendens` | `scrape-lis-pendens.mjs` |
| `scrape:pre-foreclosure` | `scrape-pre-foreclosure.mjs` |
| `scrape:evictions` | `scrape-evictions.mjs` |
| `scrape:code-violations` | `scrape-code-violations.mjs` |
| `scrape:probate-estates` | `scrape-probate-estates.mjs` |
| `scrape:clerk-foreclosures` | `scrape-clerk-foreclosures.mjs` |
| `scrape:all` | `scrape-all.mjs` |

## Leads pipeline

| npm script | Script |
|------------|--------|
| `link:leads` | `link-leads.mjs` |
| `build:lead-cards` | `build-lead-cards.mjs` |
| `enrich:property-profiles` | `enrich-property-profiles.mjs` |

## Beacon (spot-check only — prefer CAMA bulk)

| npm script | Script |
|------------|--------|
| `beacon:session` | `beacon-save-session.mjs` |
| `enrich:beacon` | `enrich-from-beacon.mjs` |

## Adding another county

Copy the pattern: `src/counties/{id}/config.mjs`, `manifest.mjs`, `arv-adapter.mjs`, plus county-specific scrapers. Reuse `src/arv/arvEngine.js` and `src/core/*` unchanged.

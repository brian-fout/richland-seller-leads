# Architecture — shared vs Richland County

This repo is a **multi-county wholesaling platform**. Richland County is the first implementation. New counties add a folder under `src/counties/{id}/` and `data/counties/{id}/` without duplicating ARV or lead-card logic.

## Directory layout

```
src/
  arv/                          # SHARED — ARV engine (all counties)
    arvEngine.js
  core/                         # SHARED — paths, ranking, scrape utilities
    county-paths.mjs
    county-context.mjs
    lead-ranking.mjs
    (scrape-state lives in scripts/ — county-aware)
    platform-leads.mjs
    name-match.mjs
    owner-contact.mjs
  counties/
    richland/                   # RICHLAND ONLY
      config.mjs                # URLs, FIPS, Beacon AppID, GIS endpoints
      manifest.mjs              # Script registry (what to re-build per county)
      arv-adapter.mjs           # Richland parcel/sales → ARV comp format

scripts/
  arv/                          # SHARED CLIs (thin wrappers)
  richland/                     # RICHLAND CLIs (future home of moved scripts)
  *.mjs                         # Legacy paths — many re-export or will move

data/
  counties/
    richland/                   # Per-county data (scrapers, CAMA, lead-cards.json)
    franklin/                   # Future counties
  platform/                     # Optional materialized cross-county exports
```

## Querying leads

| Scope | Command |
|-------|---------|
| Top N in one county | `npm run query:leads -- --county richland --limit 5` |
| Top N in a city | `npm run query:leads -- --county richland --city Mansfield --limit 5` |
| Top N platform-wide | `npm run query:leads -- --all-counties --limit 5` |

Implementation: `src/core/platform-leads.mjs` merges `data/counties/{id}/lead-cards.json` at read time and re-ranks with shared `rankLeads()`.

Migrate legacy flat `data/` → `data/counties/richland/`: `npm run migrate:data`

Full lead refresh (link → profiles → cards → ARV): `npm run refresh:leads`

Legacy flat `data/` is still supported as a fallback for Richland until migration runs.

## Quick reference

| Concern | Location | County-specific? |
|---------|----------|------------------|
| ARV math (Low/High/Most Likely, weights) | `src/arv/arvEngine.js` | No |
| Lead ranking / vacant deprioritize | `src/core/lead-ranking.mjs` | No |
| Owner contact rules | `src/core/owner-contact.mjs` | No |
| Name matching | `src/core/name-match.mjs` | No |
| Data paths | `src/core/county-paths.mjs` | Per-county roots |
| CAMA .DAT parsers | `scripts/auditor-cama-dat.mjs` | Richland (Ohio AA407) |
| GIS / parcel pull | `scripts/auditor-cama.mjs`, `pull-county-parcels.mjs` | Richland |
| Distress scrapers | `scripts/scrape-*.mjs` | Richland |
| Beacon enrichment | `scripts/beacon-*.mjs` | Richland (AppID 1067) |
| Lead linking | `scripts/link-leads.mjs` | Richland sources today |

Full Richland script list: `src/counties/richland/manifest.mjs`

## CLI — county flag

Most shared commands accept `--county richland` (default). Example:

```bash
npm run estimate:arv -- 027-04-044-07-000 --county richland
```

Data resolves to `data/counties/richland/` when present, otherwise `data/` (legacy).

## Adding a new county (e.g. Franklin)

1. `src/counties/franklin/config.mjs` — GIS URL, CAMA source, court URLs  
2. `src/counties/franklin/cama/` — ingest parsers (may reuse Ohio AA407 patterns)  
3. `src/counties/franklin/scrapers/` — distress source scrapers  
4. `src/counties/franklin/arv-adapter.mjs` — comp pool builder  
5. `data/counties/franklin/` — parcel index, sales events, lead cards  
6. Reuse `src/arv/arvEngine.js` + `src/core/lead-ranking.mjs` unchanged  

## npm scripts naming (direction)

| Prefix | Meaning |
|--------|---------|
| `npm run estimate:arv` | Shared ARV (default county) |
| `npm run richland:import:auditor-cama` | Richland-only (alias to existing during migration) |
| `npm run query:leads` | Shared lead query (county / city / all) |
| `npm run migrate:data` | One-time legacy data/ → counties/richland/ |

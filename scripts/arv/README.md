# Shared ARV scripts

County-agnostic ARV estimation. Math lives in `src/arv/arvEngine.js`. Comp building is delegated to `src/counties/{county}/arv-adapter.mjs` via `src/arv/countyAdapter.js`.

Scripts still live in `scripts/` (parent folder). Look for `@shared` in the file header.

## Commands

| npm script | Script | Purpose |
|------------|--------|---------|
| `estimate:arv` | `estimate-arv.mjs` | Single parcel ARV (JSON or `--format table`) |
| `estimate:arv:weighted` | `estimate-arv-weighted.mjs` | Weighted engine CLI |
| `batch:arv` | `batch-estimate-arv.mjs` | All lead cards → `lead-arv-by-parcel.json` |
| `batch:arv:county` | `batch-estimate-arv.mjs --county` | All improved parcels → `county-arv-by-parcel.json` |
| `test:arv` | `test-arv-engine.mjs` | Mansfield known-property regression |

## Examples

```bash
npm run estimate:arv -- 027-04-044-07-000 --format table
npm run estimate:arv -- 027-04-044-07-000 --county richland --radius-mi 0.75
npm run batch:arv
npm run test:arv
```

## Required data (per county)

- `county-parcels/comp-index-auditor.jsonl` (or `comp-index.jsonl`)
- `county-parcels/sales-events.jsonl`

Richland: produced by `npm run import:auditor-cama`.

## Output fields

Uses `arv_engine_v1`: `low`, `high`, `most_likely` (marketing ARV), confidence, comp table, explanation text.

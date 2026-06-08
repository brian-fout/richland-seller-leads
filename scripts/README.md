# Scripts

Scripts are tagged in their file header:

| Tag | Meaning |
|-----|---------|
| `@shared` | Works for any county (uses `src/core/county-context.mjs` + county adapter) |
| `@county richland` | Richland-only URLs, scrapers, or CAMA formats |

## Where things live

| Area | Location | Notes |
|------|----------|-------|
| Shared ARV CLIs | `estimate-arv.mjs`, `batch-estimate-arv.mjs`, `test-arv-engine.mjs` | See [arv/README.md](./arv/README.md) |
| Richland ingest & scrapers | `scripts/*.mjs` (see manifest) | See [richland/README.md](./richland/README.md) |
| County config | `src/counties/richland/config.mjs` | URLs, Beacon AppID, GIS endpoints |
| County registry | `src/counties/richland/manifest.mjs` | Full list of Richland scripts |

## County flag

Pass `--county richland` (default) on shared commands. Data resolves via `src/core/county-paths.mjs`:

- `data/counties/richland/` when populated
- `data/` legacy fallback for Richland

```bash
npm run estimate:arv -- 027-04-044-07-000 --county richland
npm run import:auditor-cama -- --county richland
```

Full layout: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

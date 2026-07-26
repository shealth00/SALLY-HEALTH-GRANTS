# USAspending Subcontractor Workflow Monitor

Hourly monitor that tracks federal **subcontractor / subaward** opportunities relevant to **Sally Health** (chronic care, wound care, remote patient monitoring, telehealth) from [USAspending.gov](https://www.usaspending.gov/).

> There is no resolvable `govspending.gov` host. This workflow uses the official USAspending API.

## What it does

1. Queries USAspending `/api/v2/search/spending_by_award/` for:
   - Health-related **subawards** (subcontractor lane)
   - Prime awards in health **NAICS** codes
   - Illinois health **grant** awards
2. Normalizes results into a stable opportunity list
3. Diffs against the previous snapshot
4. Writes:
   - `data/opportunities.json` — current opportunities
   - `data/last-run.json` — monitor summary / deltas

## Run

```bash
# Prefer live USAspending API; falls back to fixtures if unreachable
node govspending/monitor.js

# Force fixture data (CI / offline)
node govspending/monitor.js --fixtures

# Preview without writing
node govspending/monitor.js --fixtures --dry-run

# Machine-readable summary
node govspending/monitor.js --fixtures --json
```

## Tests

```bash
node --test govspending/test/monitor.test.js
```

## API (backend)

When the Express server is running:

- `GET /api/govspending/opportunities` — latest snapshot
- `GET /api/govspending/status` — last-run summary
- `POST /api/govspending/refresh` — run monitor (`{"fixtures": true}` optional)

## Config

Edit `config.json` to tune keywords, NAICS codes, agencies, lookback window, and query lanes for Sally Health.

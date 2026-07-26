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

# Admin oversight report (alerts / action required)
node govspending/monitor.js --admin
```

## Admin oversight

Each run writes an `admin` block to `data/last-run.json`:

| `overall` | Meaning |
|-----------|---------|
| `healthy` | Live USAspending queries succeeded |
| `attention` | Partial live success or preserved-snapshot safeguard |
| `degraded` | Live API unavailable; fixtures fallback (not production alerts) |

Key alert codes:

| Code | Meaning |
|------|---------|
| `EGRESS_BLOCKED` | Transport/network failure reaching USAspending (allowlist/firewall) |
| `LIVE_API_UNAVAILABLE` | Live API failed for a non-egress reason |
| `PRODUCTION_ALERTS_SUPPRESSED` | Fixture fallback must not drive opportunity actions (always set when `sourceMode` is `fixtures-fallback`) |
| `PARTIAL_LIVE_QUERY_FAILURE` | One or more query lanes failed; others succeeded |
| `PRESERVED_LIVE_SNAPSHOT` | Prior live snapshot kept instead of writing fixtures |

Admin also exposes booleans `egressBlocked` and `productionAlertsSuppressed`, plus `requiredEgressDomains`, for machine-readable oversight.

Safeguards:

- Query lanes fail independently (`live-partial`) so one timeout does not discard other live results
- Fixture fallback never overwrites a previous **live** opportunities snapshot
- No-delta fixture fallbacks refresh `last-run.json` only (no opportunities churn)
- Only commit opportunity deltas when `hasChanges: true` **and** `sourceMode` is `live` / `live-partial`

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

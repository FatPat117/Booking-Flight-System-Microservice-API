# Day 2 — Session Notes

**Date started:** 2026-07-11
**Theme:** Runtime validation + Flight business rules (manual, no libraries)
**Status:** Request changes addressed — awaiting re-review (calendar + JSON primitives)

## Architecture end of day

```text
Client → express.json() → POST /api/flights
  → Validate shape → Normalize → Business rules
  → Conflict check → Create → Flight[] RAM
```

## Must change

- Only upgrade `POST /api/flights`
- Manual validation (`unknown`, no cast)
- Collect field errors → `422 VALIDATION_FAILED`
- Duplicate `flightNumber + departureAt` → `409 FLIGHT_ALREADY_EXISTS`
- Normalize codes + UTC timestamps
- Explicit mapping (no `...req.body`)
- Validate before mutate
- Document rules in README
- No new folders / no Joi / Zod / Service / Repo / DI / DB

## Intentionally NOT today

Schema libs, Controller/Service/Repo, DI, DB, automated tests, middleware error framework

## After completion

Manual test matrix (10 cases) → PR review or mark complete → Day 3

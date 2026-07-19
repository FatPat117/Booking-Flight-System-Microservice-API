# CURRENT PROGRESS

**Last completed day:** Day 11
**Current day:** Day 11 — Liveness & Readiness
**Status:** Completed — awaiting mentor review / commit

## Day 11 delivered

```text
GET /live   → process liveness
GET /health → alias for /live
GET /ready  → SQLite SELECT 1 → 200 | 503
```

- `src/health/health-checks.ts`
- Wired into AppDependencies + index.ts
- Tests: health.api + health-checks unit
- Quality gate: **91 tests pass**

## Next

Day 12 when assigned (auth / who can create Flight).

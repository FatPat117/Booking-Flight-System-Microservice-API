# Day 6 — Session Notes

**Date started:** 2026-07-12
**Theme:** Repository Pattern — separate SQLite from HTTP
**Status:** COMPLETED (2026-07-12) — Implementation complete — awaiting review

## Real pressure

`app.ts` owns HTTP + validation + SQL + FlightRow mapping (~446 lines).

## Must build

```text
src/flights/flight-repository.ts       → contract (no SQLite/Express)
src/flights/sqlite-flight-repository.ts → SQL, mapping, changes→outcome
createApp(flightRepository)
index.ts composition: openDB → repo → createApp
tests/sqlite-flight-repository.test.ts
API tests wire real SQLite repo
Fix persistence test finally cleanup
```

## NOT today

GenericRepo, ORM, UoW, Service Layer, DI container, CQRS, Controller classes

## Outcome contract

```ts
create() → { outcome: "created" } | { outcome: "duplicate" }
```

Route maps duplicate → 409. Repository never returns HTTP status.

## Quality gate

Keep all existing API behavior; add repo tests; typecheck/build/test/start.

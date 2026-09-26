# CURRENT PROGRESS

**Last completed day:** Day 36
**Current day:** Day 36 — Strangler Fig step 1 (dev-complete): `FlightRepository` on Postgres/TypeORM
**Status:** Closed — `PostgresFlightRepository` built and tested against real `booking_db`; not wired into `bootstrap/application.ts`, SQLite still runs production

## Day 36 delivered

```text
booking_db (second logical database, same Postgres container as identity_db)
FlightEntity (TIMESTAMPTZ) + hand-written migration (7 CHECK + UNIQUE)
PostgresFlightRepository — 23505 unique_violation -> outcome: "duplicate"
First real-Postgres integration test tier (npm run test:integration)
FlightRepository + TransactionRunner made async (required — pg has no
  sync driver); SQLite behavior unchanged; ~10 files + tests updated
```

## Biggest catches

```text
1. Making TransactionRunner.run async inserted a microtask yield point
   that let two concurrent bookings interleave BEGIN on the single
   SQLite connection ("cannot start a transaction within a transaction").
   Fixed with an explicit promise-queue serializing transactions on the
   connection, instead of relying on synchronous run-to-completion by
   accident, as before. All 171 tests + both Day 26/28 race tests pass.
2. Adding tests/integration/ silently broke `npm test`'s glob
   (tests/**/*.test.ts collapses to one directory level under sh,
   without globstar) — it started matching ONLY the integration folder
   and dropped all 23 top-level test files. Fixed with tests/*.test.ts
   (matches this repo's own "tests/ is flat" convention).
```

## Previous day (Day 35) recap

```text
docs/migration-plan-postgres.md: dependency inventory, 6 behavior deltas,
no dual-write/export decision, 6 risks+mitigations, and the transactional-
coupling finding that split "dev-complete per repo" from "one combined
cutover" (flights/audit/outbox/bookings share one TransactionRunner).
```

## Next

Day 37 — Strangler Fig step 2: migrate `OutboxRepository` to Postgres/TypeORM (dev-complete), per `docs/migration-plan-postgres.md` Section 5.1 order.

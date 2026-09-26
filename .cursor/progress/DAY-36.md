# Day 36 — Session Notes

**Date completed:** 2026-09-26
**Theme:** Strangler Fig step 1 (dev-complete): migrate `FlightRepository` to Postgres/TypeORM
**Status:** Completed — `PostgresFlightRepository` exists, tested against a real Postgres
`booking_db`; not wired into `bootstrap/application.ts` — SQLite still runs production,
per `docs/migration-plan-postgres.md` Section 5.1/5.2 (dev-complete vs cutover)

## Why `booking_db`, not a second Postgres container

```text
api and identity are different bounded contexts (flights/bookings/audit/
outbox vs users) — sharing one database/schema would let one service
JOIN straight into the other's tables, a classic microservices anti-
pattern (schema coupling instead of API/event coupling). But a second
*container* isn't justified yet — no operational need (backup/scale/
version) differs between them at this scale. Same container, two
logical databases: same trade-off shape as Day 22 (copy code instead of
monorepo tooling) — split the thing that actually needs splitting now
(schema), defer the thing that doesn't (infrastructure) until there's a
real reason.
```

## Who converts Date <-> string (the port/adapter boundary)

```text
Flight (domain type, src/types.ts) keeps departureAt/arrivalAt as ISO
strings — unchanged. FlightEntity (TypeORM) uses Date (TIMESTAMPTZ).
PostgresFlightRepository's mapFlight()/create() is the ONLY place that
converts between them — same rule this repo has followed since Day 6
("repository interface must not know about storage-layer types").
```

## Biggest catch #1: the port had to become async, and that broke a hidden invariant

```text
FlightRepository's 3 methods were synchronous, matching node:sqlite's
real sync API — pg/TypeORM have no sync driver, so "implement the port
unchanged" (this day's original brief) was not actually possible.
Converting FlightRepository + TransactionRunner to return Promises
(SQLite behavior unchanged underneath) surfaced a real bug: making
TransactionRunner.run always `await operation()` inserted a microtask
yield point that never existed before — two concurrent bookings via
Promise.all could now interleave BEGIN IMMEDIATE on the single shared
SQLite connection ("cannot start a transaction within a transaction").
Previously, BEGIN..COMMIT always ran as one uninterrupted synchronous
slice, so this could never happen — an implicit guarantee, not a
designed one. Fixed by explicitly serializing transactions on the
connection with a promise queue instead of relying on synchronous
run-to-completion by accident. All 171 tests still pass, including the
Day 26/28 Promise.all race-condition tests.
```

## Biggest catch #2: `tests/integration/` silently broke `npm test`

```text
Adding tests/integration/*.test.ts changed what `tests/**/*.test.ts`
matched under sh (npm's script shell, not an interactive bash/zsh) —
without globstar, `**` collapses to one directory level, so the glob
started matching ONLY tests/integration/*.test.ts and silently dropped
all 23 top-level test files. Caught by checking `ℹ tests <n>` in the
output, not by assuming green output meant full coverage. Fixed by
switching to tests/*.test.ts (non-recursive), which also matches this
repo's own stated convention that tests/ is flat.
```

## Delivered

```text
docker/postgres-init/01-create-booking-db.sh — booking_db, second
  logical database in the existing Postgres container
api/src/postgres/{config,data-source}.ts — standalone, not wired into
  bootstrap/application.ts
api/src/flights/postgres/flight.entity.ts — TIMESTAMPTZ per Day 35;
  @PrimaryColumn not @PrimaryGeneratedColumn (create-flight.ts already
  assigns id before calling the repository)
api/src/postgres/migrations/1790424994000-CreateFlights.ts — hand-written,
  mirrors the 7 CHECK constraints + UNIQUE from the SQLite migration
api/src/flights/postgres/postgres-flight-repository.ts — implements
  FlightRepository; 23505 unique_violation -> { outcome: "duplicate" }
  (discriminated union, not a throw — matches the port's existing
  contract, unlike identity's UserRepository which throws)
api/tests/integration/postgres-flight-repository.integration.test.ts —
  first test in this repo to hit a real Postgres (Day 35's Section 4
  risk #5); npm run test:integration, separate from npm test
FlightRepository + TransactionRunner made async (SQLite behavior
  unchanged); create-flight.ts, list-flights.ts, app.ts (2 routes),
  flights-summary-job.ts, and ~10 test files updated to match
```

## Verified end to end

```text
docker compose exec postgres psql -U identity -l -> both databases exist
npm run postgres:migration:run -> flights table created in booking_db
\d flights -> TIMESTAMPTZ columns, unique constraint, 7 CHECK constraints
npm run test:integration -> 4/4 pass against real Postgres (create,
  duplicate via real 23505, findPage ordering, findById miss)
npm test (root, all workspaces) -> 171 (api) + 12 (identity) + 4
  (flight-notifier) pass
npm run typecheck / typecheck:test (root, all workspaces) -> clean
```

## Not today

```text
No cutover — bootstrap/application.ts still constructs SqliteFlightRepository
  and SqliteTransactionRunner; production behavior is unchanged
OutboxRepository, AuditRecorder, BookingRepository not migrated (Strangler
  Fig steps 2-4, per docs/migration-plan-postgres.md Section 5.1 order)
No CHECK-constraint-violation tests (not part of this day's brief)
```

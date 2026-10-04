# ADR-005: Unit Tests on In-Memory Fakes, Database Semantics on Real Postgres

## Status

Accepted (Day 41)

## Context

Until Day 40, most `api` tests ran against SQLite `:memory:`: use case tests, HTTP tests built with `createApp()`, repository tests, and the Day 26/28 race tests. That was convenient because SQLite was also the production database.

After the Postgres cutover (Day 40, [ADR-006](./006-sqlite-to-postgres-migration.md)), keeping SQLite only so tests have something to run on would mean testing on a database whose **semantics differ from production in exactly the places that matter**. Days 35–39 found three such places:

- **Foreign keys.** SQLite never enforced the `bookings.flight_id` FK (Day 35).
- **Concurrency.** SQLite uses one serialized connection. The naive SELECT-then-UPDATE overbooks on Postgres but never does on SQLite (Day 39 counter-proof).
- **Error behavior.** `COMMIT` on an aborted Postgres transaction silently rolls back (Day 38, ADR-004 addendum).

It would also mean maintaining an adapter that never runs in production.

Running *every* test against Postgres has the opposite problem. `npm test` would require infrastructure, and most tests check business logic or HTTP mapping that no database can make more or less correct.

## Decision

Split the tests by **what they can actually prove**.

| Tier | Runs on | Proves |
|---|---|---|
| Unit + HTTP (`tests/*.test.ts`, `npm test`) | Hand-written in-memory fakes (`tests/fakes/in-memory.ts`) | Business logic: validation, outcomes (`duplicate`, `sold-out`, …), call order, audit/outbox contents, HTTP status and error envelope, auth |
| Integration (`tests/integration/*.test.ts`, `npm run test:integration`) | Real Postgres (`booking_db`, the `booking` role) | Database semantics: transactions and rollback, FK/unique constraints, OCC under real concurrent connections, migrations, health check |

**Contract tests** keep the fakes honest. A port's promised behavior is written once (`tests/contracts/<port>.contract.ts`) and run against both the fake (unit tier) and the Postgres adapter (integration tier). If the fake drifts from the real adapter, the same assertion passes on one side and fails on the other. `BookingRepository` has one today.

Fakes deliberately do **not** simulate database semantics. In particular, the in-memory `TransactionRunner` does not roll back. A test that only makes sense if rollback or locking is real belongs in the integration tier, where it can fail.

## Consequences

**Positive**

- `npm test` needs no Postgres, RabbitMQ or Docker, and stays fast (≈1s for ~160 tests).
- Every test that touches a database runs on the production engine, so no green test is resting on SQLite-only behavior.
- One fewer adapter per port to maintain when a port changes. The four sync→async conversions on Days 36–39 each had to touch two adapters.
- Race tests exist only where they can fail. A race test on a single-threaded fake passes regardless of the code, so it was deleted rather than converted.

**Trade-offs / costs**

- **Fakes can drift.** Contract tests cover only `BookingRepository` so far. The `FlightRepository` fake (duplicate detection by instant, ordering) is the most likely next drift and the first candidate for a second contract.
- **Two tiers to run.** A change to SQL or transaction code is only covered once someone runs `npm run test:integration` against a live Postgres. CI doesn't enforce that yet.
- **The integration tier is destructive on shared dev data.** It `TRUNCATE`s tables in `booking_db`, the same database the docker-compose stack uses. A separate test database is a possible later fix.
- **Fakes are code too.** They need the same review as production code, especially the "return copies, never internal references" rule.

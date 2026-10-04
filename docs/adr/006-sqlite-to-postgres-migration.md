# ADR-006: Move `api` Storage from SQLite to Postgres/TypeORM

## Status

Accepted. Completed on Day 41 (planned Day 35, cut over Day 40, SQLite removed Day 41).

The detailed plan, the SQLite vs Postgres behavior differences and the rollback analysis are in [`docs/migration-plan-postgres.md`](../migration-plan-postgres.md). This ADR records only the decision.

## Context

Since Day 5, `api` stored flights, bookings, audit logs and the outbox in `node:sqlite`, with one file and one connection. By Day 35 that choice had stopped being cheap.

- **Identity already ran on Postgres** (Day 31). The system had two database engines with two sets of operational knowledge.
- **SQLite hid real bugs.** FKs were never enforced, and one serialized connection meant the OCC design (ADR-004) had never been tested under real concurrent writers.
- **The destination architecture uses Postgres/TypeORM per service.** Staying on SQLite would make every later step (more services, more instances) start with a migration anyway.

## Decision

Move all of `api`'s storage to **Postgres (`booking_db`) via TypeORM**, accessed through a dedicated `booking` role with no access to `identity_db`. The migration ran as a strangler fig:

1. Write and integration-test one Postgres adapter per port, behind the **unchanged** ports (Days 36–39).
2. Switch `bootstrap/application.ts` to all four adapters plus `PostgresTransactionRunner` in **one** commit (Day 40). The four tables share one transaction boundary, so a per-table cutover would have broken atomicity.
3. Delete SQLite in a **separate** commit (Day 41), once the cutover had proven stable and the test strategy without SQLite was decided ([ADR-005](./005-test-strategy-fakes-and-postgres-integration.md)).

No dual-write and no data migration: there was no real traffic, and dev data was disposable.

## Consequences

**Positive**

- One database engine across services.
- FK, CHECK and TIMESTAMPTZ constraints are enforced by the database, not by convention.
- OCC is proven under real concurrency (`postgres-booking-race.integration.test.ts`).
- The ports held. No use case, the relay job and the HTTP layer did not change during the cutover, which is evidence the Day 6/7 repository and use-case boundaries were drawn in the right place.

**Trade-offs / costs**

- Running `api` now needs a Postgres container. SQLite needed nothing. Unit tests avoid this through fakes (ADR-005).
- Migrations still run at startup, which is safe only while there is a single `api` instance.
- **The SQLite deletion (Day 41) is the point of no return.** Going back means restoring code from git history and re-wiring by hand, not a `git revert`.
- Every port that can touch I/O had to become `Promise`-based, rippling through every caller and fake. It is now a standing rule in `CLAUDE.md`.

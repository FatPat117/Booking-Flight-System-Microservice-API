# Day 35 — Session Notes

**Date completed:** 2026-09-19
**Theme:** Evaluate & plan `api` SQLite → Postgres/TypeORM migration (Strangler Fig)
**Status:** Completed — `docs/migration-plan-postgres.md` written; no application code changed

## Why a full day for planning only

```text
This is the highest-risk change since Day 1 — it swaps the storage for
real flights/bookings/audit/outbox data, unlike Day 27 (npm workspaces)
which never touched data. A day spent purely on inventory + risk
assessment, before any migration code exists, is the same "isolate the
source of change" principle as Day 19 (infra before code) applied at
much larger scale.
```

## Biggest catch of the day

```text
The originally assumed strategy — migrate one repository at a time, cut
each to production independently — doesn't hold. create-flight.ts wraps
flightRepository + auditRecorder + outboxRepository in one
transactionRunner.run(); create-booking.ts/cancel-booking.ts wrap
bookingRepository + outboxRepository in another. Union: flights,
audit_logs, outbox, and bookings all share one atomicity boundary today.
Cutting one table to Postgres while the others stay on SQLite would
silently break Day 14's atomicity guarantee mid-migration — the same
dual-write failure mode Day 24's Outbox pattern exists to avoid, just
introduced by the migration itself instead of by messaging.

Resolution: split "write and unit-test each repository" (still one at a
time, in risk order: Flight → Outbox → Audit → Booking) from "cut
production over" (one atomic step for all four, once all four are
individually dev-complete).
```

## Other key decisions

```text
Strangler Fig write order: Flight (lowest risk) → Outbox → Audit →
  Booking (highest risk, has OCC)
No dual-write, no export/import script: api/data/booking.db is
  gitignored dev-only data; start Postgres empty, discard it
TIMESTAMPTZ: switch on FlightRepository only (lowest-risk place to
  absorb the type change; removes the arrival_at > departure_at
  string-comparison assumption). Audit/Outbox keep TEXT — no ordering
  comparison depends on it, less reason to churn.
bookings.flight_id FK is currently UNENFORCED (no PRAGMA foreign_keys =
  ON) — Postgres enforces it unconditionally; a real (if narrow)
  behavior change, not just a syntax port
Zero tests in this repo hit a real database today — even services/identity
  (already on Postgres) tests exclusively against in-memory fakes.
  Migrating api's repositories is this project's first need for a
  real-Postgres integration-test tier.
```

## Delivered

```text
docs/migration-plan-postgres.md, 5 sections:
  1. Dependency inventory — 9 files in api/src + 3 test files, via grep
     (not recalled from memory; actual count was lower than guessed)
  2. 6 SQLite/Postgres behavior deltas, ranked by risk (conditional
     UPDATE affected-row-count; BEGIN IMMEDIATE has no PG equivalent;
     unenforced FK; TEXT vs TIMESTAMPTZ; STRICT mode; partial index)
  3. Data export/import decision: none — discard dev data, migrate from
     an empty Postgres, with an explicit contrast against what a real
     production migration would need instead
  4. 6 concrete risks, each tied to a Section 1/2 finding, each with a
     stated mitigation
  5. Completion criteria split into per-repository dev-complete
     checklists (ordered) and one combined cutover checklist
```

## Not today

```text
No application code touched — planning only, per Day 35's own checklist
Actual migration execution (Day 36+): start with FlightRepository
```

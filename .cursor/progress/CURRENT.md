# CURRENT PROGRESS

**Last completed day:** Day 35
**Current day:** Day 35 — Evaluate & plan `api` SQLite → Postgres/TypeORM migration
**Status:** Closed — `docs/migration-plan-postgres.md` written (5 sections); no application code changed

## Day 35 delivered

```text
Dependency inventory (9 files in api/src + 3 test files, via grep)
6 SQLite/Postgres behavior deltas ranked by risk
Data export/import decision: none, discard dev-only SQLite data
6 concrete risks + mitigations
Completion criteria: per-repo dev-complete (ordered) + one combined
  cutover step — NOT independent per-table cutover (see below)
```

## Biggest catch

```text
create-flight.ts and create-booking.ts/cancel-booking.ts each wrap
multiple repositories in one shared TransactionRunner — flights,
audit_logs, outbox, and bookings are all transactionally coupled today.
"Migrate one table at a time, cut to production independently" would
silently break Day 14's atomicity guarantee mid-migration. Resolved by
splitting dev-complete (per repo, ordered) from cutover (one atomic step
for all four).
```

## Previous day (Day 34) recap

```text
Identity users.role + migration + promote-to-admin CLI; JWT payload
includes role; requireRole middleware; POST /api/flights on JWT admin
only; ADMIN_API_KEY gone; register mass-assignment closed with a test.
```

## Next

Day 36 — Execute Strangler Fig step 1: migrate `FlightRepository` to Postgres/TypeORM (per `docs/migration-plan-postgres.md` Section 5.1).

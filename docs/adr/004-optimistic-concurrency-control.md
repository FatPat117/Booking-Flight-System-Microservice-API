# ADR-004: Optimistic Concurrency Control via Conditional UPDATE

## Status

Accepted

> **Update (Day 41):** storage is now Postgres — see [ADR-006](./006-sqlite-to-postgres-migration.md). The decision held unchanged: the conditional `UPDATE` was ported as-is and proven under real concurrent connections (`postgres-booking-race.integration.test.ts`), which SQLite's single connection never exercised.

## Context

Booking flows mutate contested state: scarce seats (create) and one-shot transitions (cancel). A classic **read-then-write** in application code allows two concurrent requests to both observe “allowed” and both succeed — overbooking, or releasing a seat twice.

SQLite in this project does not offer convenient Postgres-style `SELECT … FOR UPDATE` row locks as a first-class teaching path, and pessimistic locking would add session/lock complexity for a simple decrement-or-transition rule.

We needed a pattern that:

1. Decides and writes in **one** database statement.
2. Distinguishes outcomes (`sold-out` vs `not-found`, `already-cancelled` vs `not-found`) only on the failure path.
3. Can be reused for both “scarce resource” and “must not repeat” races.

## Decision

Use **optimistic concurrency via conditional `UPDATE … WHERE <guard>`** (e.g. `available_seats > 0`, or `status = 'active'`). Treat `changes === 1` as success; on `changes === 0`, run a small read only to classify the failure. Side effects that depend on winning the race (seat release, outbox) run **only** after a successful first transition, inside the same application transaction.

## Consequences

**Positive**

- Correct under concurrent callers without holding long-lived locks.
- Same mental model for overbooking and double-cancel — learn once, apply twice.
- Portable toward stricter SQL engines later (same `UPDATE` shape).

**Trade-offs / costs**

- Correctness depends on **developer discipline**: every contested write must use a conditional UPDATE. Nothing in the framework auto-enforces that (no lint rule yet).
- Failure classification needs an extra SELECT on the miss path — acceptable, but easy to skip and return a vague error.
- Under heavy contention, many requests fail with conflict outcomes (409) instead of waiting — usually desirable for UX clarity, but not “fair queuing.”
- Checklist / review habit is enough at current size; automated enforcement stays optional until a real miss happens in review.

## Addendum (Day 38): a caught DB error must end the transaction's work immediately

While migrating `OutboxRepository`/`AuditRecorder` to Postgres, we confirmed a sharp edge in how
this ADR's conditional `UPDATE`/`INSERT` interacts with `PostgresTransactionRunner`:
`COMMIT` issued against an **already-aborted** Postgres transaction does not throw — the server
silently performs a `ROLLBACK` instead and returns a plain `ROLLBACK` completion, with no
client-visible error. Only a query attempted *after* the failed statement (but before
COMMIT/ROLLBACK) throws (`current transaction is aborted, commands ignored until end of
transaction block`).

Practical rule: once a repository catches a Postgres error inside `transactionRunner.run()`
(e.g. `23505` unique violation) and reports it as an outcome (`duplicate`), the calling code must
return immediately — it must not run any further query in that same transaction, and it must not
treat the caller's successful-looking return value as proof anything was persisted beyond what
ran before the failure. `postgres-flight-repository.ts`'s `create()` and `create-flight.ts`'s
early return on `{outcome: "duplicate"}` already follow this by construction; it's now written
down so the next repository (or the next engineer) doesn't add a write after a caught error and
assume it survives.

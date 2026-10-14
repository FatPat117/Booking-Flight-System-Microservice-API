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

## Addendum (Day 47): seat allocation locks rows — `FOR UPDATE SKIP LOCKED`

Day 47 replaced the `available_seats` counter with one `flight_seats` row per seat. Booking no
longer asks "is the count above zero?" but "give me **one** free seat, any one". That is a
different shape of contention, and the conditional `UPDATE` of this ADR is the wrong tool for it.

**Why OCC fails here.** The OCC version would be: pick the first AVAILABLE seat, then
`UPDATE ... WHERE (seat) AND status = 'AVAILABLE'`. Twenty concurrent bookings all pick the same
first seat (`1A`); one wins, nineteen match zero rows. Zero rows here does **not** mean sold out
— 49 other seats are free — so each loser must re-pick and retry, colliding again on `1B`, and so
on. Either the callers retry in a loop (n² work under contention, unbounded latency) or they
report `sold-out` while seats are free: a false refusal. A counter had a single row, so "zero
rows" did mean "nothing left"; a pool of interchangeable rows breaks that equivalence.

**Decision.** Pick and claim in one statement with row locks:

```sql
WITH picked AS (
  SELECT ... FROM flight_seats seat JOIN flights flight ...
  WHERE seat.status = 'AVAILABLE' AND <BR-FLT-06 on flight>
  ORDER BY seat.row, seat.letter LIMIT 1
  FOR UPDATE OF seat SKIP LOCKED
  FOR SHARE OF flight
)
UPDATE flight_seats ... FROM picked ... RETURNING row, letter
```

- `FOR UPDATE OF seat` — the chosen seat is locked before it is written, so two transactions can
  never claim it (the `UPDATE` re-checks nothing it did not lock).
- `SKIP LOCKED` — a seat another transaction is claiming right now is passed over instead of
  waited on: twenty callers take twenty different seats in parallel. No retry loop.
  Measured without it (control Tests C1/C2): **no** false sold-out on Postgres — `LockRows` sits
  under `Limit` in the plan, so a row that fails the READ COMMITTED re-check after the wait is
  dropped and the next row of the sort is tried. 20 concurrent bookings on 50 seats still got 20
  distinct seats. The cost is the queue: every caller locks `1A` first and waits for each
  in-flight claimer in turn (C2: with one open claim on `1A`, the next caller hits
  `lock_timeout`; with `SKIP LOCKED` it gets `1B` at once). Locally Test C1 ran ~1.5× slower
  than Test B; the gap grows with how long a booking transaction stays open (audit, outbox).
- `FOR SHARE OF flight` — the sales window (BR-FLT-06) is read from a flight row that cannot
  change status until this transaction ends. The counter `UPDATE` got that for free (it wrote the
  flight row); a seat-only statement would not. Share locks do not conflict with each other, so
  bookings still run in parallel; only a status change waits for them.

**Why this is not the "pessimistic where OCC suffices" anti-pattern.** The locks live for one
statement plus the rest of a short transaction, are taken in a fixed order (one seat, then its
flight), and are never held across a user's think time. The problem — choose one of many
interchangeable resources — is exactly what `SKIP LOCKED` exists for (job queues use it for the
same reason). OCC remains the rule for one-row transitions: cancel is still a conditional
`UPDATE ... WHERE status = 'active'`, now releasing the seat in the same statement.

**Remaining edge, accepted.** `sold-out` now means "no AVAILABLE seat that no other transaction
is claiming". If the last free seats are being claimed by transactions that then roll back, a
caller in that instant hears `sold-out` while a seat comes back a moment later. That needs both a
nearly full flight and a rollback after the claim (audit/outbox failure); a retry from the client
then succeeds. Waiting instead (no `SKIP LOCKED`) would remove this edge — the waiter would get
the seat once the claimer rolls back — but would make every booking on a busy flight queue
behind the others, which is the worse trade.

**Fake vs. Postgres.** The in-memory fake allocates in the same (row, letter) order, so the
contract tests pin the sequential behavior on both. Concurrency is proven only on Postgres
(ADR-005): the race tests in `postgres-booking-race.integration.test.ts`.

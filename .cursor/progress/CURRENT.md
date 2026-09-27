# CURRENT PROGRESS

**Last completed day:** Day 39
**Current day:** Day 39 — Strangler Fig step 4 (dev-complete): `BookingRepository` on Postgres/TypeORM + OCC proven under real concurrency
**Status:** Closed — `PostgresBookingRepository` built and tested against real `booking_db`, including two real-concurrency race tests (overbooking, double-cancel) and a permanent counter-proof of the naive SELECT-then-UPDATE anti-pattern; not wired into `bootstrap/application.ts`, SQLite still runs production. **All 4 repositories (Flight, Outbox, Audit, Booking) are now dev-complete** — only the combined cutover remains.

## Day 39 delivered

```text
2 rules from Day 38 review recorded: CLAUDE.md (port I/O -> Promise from the
  start) and docs/adr/004-optimistic-concurrency-control.md addendum
  (a caught DB error must end the transaction's work immediately)
BookingRepository port made async (4th repository to convert: Flight,
  Outbox, Audit, Booking), SQLite behavior unchanged
BookingEntity + migration — FK to flights (NO ACTION, no delete-flight
  feature exists yet), idx_bookings_flight_id, strict status CHECK
PostgresBookingRepository — reserveSeat/releaseSeat compute
  available_seats +/- 1 in SQL (not TypeScript); cancel() uses RETURNING
  instead of a separate SELECT on the success path
5 new integration test files: repository methods sequentially (incl. FK
  rejection), CreateBooking/CancelBooking full-adapter use-case tests, and
  a race-test file with 3 tests: 20-concurrent-callers overbooking (5
  seats), 10-concurrent double-cancel, and a permanent counter-proof
  reproducing real overbooking with a naive SELECT-then-UPDATE
```

## Biggest catches

```text
1. TypeORM's UpdateQueryBuilder.returning([...]) takes entity PROPERTY
   PATHS ("flightId"), not DB column names ("flight_id") — the wrong name
   doesn't error, it silently produces no RETURNING clause at all
   (result.raw stays []).
2. Adding bookings.flight_id's FK broke 3 existing integration tests'
   beforeEach TRUNCATEs (Postgres refuses to truncate a table referenced by
   another table's FK without CASCADE or including the referencing table) —
   an expected consequence of the FK now being real (Day 35 found SQLite
   never enforced it), not a new bug.
3. Test C (naive SELECT-then-UPDATE, 20 concurrent callers vs. 5 real
   seats, 30ms artificial delay): 20/20 "reserved" every run, final
   available_seats landing on 4 every time (lost update — every racer
   computed 5-1=4 off the same stale read). Stable across 3 runs; kept
   permanently as a counter-proof, same reasoning as Day 37's.
```

## Previous day (Day 38) recap

```text
AuditEntity + PostgresAuditRecorder (throws outside a transaction, same
pattern as Outbox); first end-to-end use-case integration test
(createCreateFlight on all-Postgres adapters); found that COMMIT on an
already-aborted Postgres transaction silently ROLLBACKs with no error.
```

## Next

Day 40 — **Cutover**: switch all of `api` to Postgres in one combined step, per the plan adjusted on Day 35 (dev-complete per repository, one cutover for all 4 tables together, since they share one `TransactionRunner.run()` boundary).

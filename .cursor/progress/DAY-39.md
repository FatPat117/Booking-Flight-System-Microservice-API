# Day 39 — Session Notes

**Date completed:** 2026-09-27
**Theme:** Strangler Fig step 4 (dev-complete): `BookingRepository` on Postgres/TypeORM +
OCC (ADR-004) proven under real concurrency — the highest-risk repository in the migration
**Status:** Completed — `PostgresBookingRepository` exists, tested against real `booking_db`
including two real-concurrency race tests and one counter-proof; not wired into
`bootstrap/application.ts` — SQLite still runs production. All 4 repositories are now
dev-complete; only the combined cutover (Day 40) remains.

## Why this was the highest-risk step

```text
The first 3 repositories only wrote new rows or read. BookingRepository is the
only one that mutates a row multiple concurrent requests actually contend for
(flights.available_seats). On SQLite this was never truly tested under
concurrency — one connection, and SqliteTransactionRunner's promise queue
(Day 36) serializes every transaction, so two reserveSeat calls never
literally overlap. Day 39 is the day that gap gets closed: real Postgres
connections, real parallel transactions, real row locks.
```

## 2 rules carried over from Day 38 review (Step 0)

```text
1. A port that can touch I/O declares Promise<...> from the start — recorded
   in CLAUDE.md's "Code style conventions" (this is the 4th repository/port
   that had to convert from sync to async: Flight, Outbox, Audit, Booking).
2. A DB error caught inside a transaction must end that transaction's work
   immediately; a successful-looking return value must not be read as proof
   anything was persisted — recorded as an addendum to
   docs/adr/004-optimistic-concurrency-control.md (directly relevant there:
   it's exactly the conditional-UPDATE/duplicate-outcome mechanism that
   surfaced the "COMMIT on an aborted transaction silently ROLLBACKs" edge
   case on Day 38).
```

## Biggest catches

```text
1. TypeORM's UpdateQueryBuilder.returning([...]) takes entity PROPERTY PATHS
   (e.g. "flightId"), not raw database column names ("flight_id") — passing
   the column name doesn't error, it just silently produces no RETURNING
   clause at all (result.raw stays []). Found immediately by the cancel()
   integration test failing with "Cannot read properties of undefined" on
   the first real run; confirmed via a scratch script with query logging
   showing the generated SQL had no RETURNING clause until the property name
   was used instead.
2. Adding bookings.flight_id's foreign key broke 3 EXISTING integration test
   files' beforeEach (`TRUNCATE TABLE "flights", ...` without CASCADE) —
   Postgres refuses to truncate a table referenced by another table's FK
   unless the referencing table is included or CASCADE is used. Not a new
   bug in this day's code; a direct, expected consequence of Day 35's other
   finding (SQLite never enforced this FK at all) now being real. Fixed by
   adding CASCADE to postgres-flight-repository.integration.test.ts,
   postgres-transaction-runner.integration.test.ts, and
   create-flight.postgres.integration.test.ts.
3. Running two Postgres integration test files together WITHOUT
   --test-concurrency=1 (i.e. bypassing the npm script) reproduced the
   exact Day 37 cross-file TRUNCATE race again, right on schedule — a
   useful confirmation that the fix from Day 37 is still the load-bearing
   guard, not something that happened to stop mattering.
```

## Deadlock reasoning (Step 4 Pause & Think) — no real risk today

```text
CreateBooking's lock order: flights row (reserveSeat) -> a brand-new
bookings row (create, nothing to contend for). CancelBooking's lock order:
an EXISTING bookings row (cancel) -> flights row (releaseSeat) — the
reverse order.

For a deadlock, two transactions need to hold what the other is waiting
for, in both directions at once. CreateBooking never locks any EXISTING
bookings row (its INSERT only creates a row nobody else references yet),
so it can never be the transaction "holding a bookings-row lock that
CancelBooking is waiting on." The only shared contested resource between
the two use cases is the flights row itself — a single resource, so at
worst one transaction waits for the other; there's no second resource for
the wait to point back through. Conclusion: safe today. This would become a
real risk only if a future use case locked an EXISTING bookings row and the
flights row in the same two-resource shape but in reversed order from
CancelBooking's — worth re-checking if/when a bulk-operation use case
(e.g. "cancel all bookings for a flight") is ever added.
```

## Decisions made this session

```text
FK delete policy: flight_id REFERENCES flights(id) with no ON DELETE clause
  (Postgres default: NO ACTION) — there is no delete-flight feature yet;
  NO ACTION blocks a future delete outright instead of silently cascading
  away booking history, matching the "least destructive default until the
  real need is known" principle already used for Day 34's default role.
status CHECK stays strict (IN ('active', 'cancelled')) — unlike audit_logs'
  deliberately loose CHECK, this is business data with a genuinely fixed,
  small value set, matching SQLite's own 005_add_booking_status migration.
idx_bookings_flight_id kept on the new Postgres table (mirrors SQLite) —
  corrected reasoning (Day 40 review): NOT for reserveSeat/releaseSeat, which
  look flights up by its own primary key (id), never by scanning bookings.
  It serves the FK constraint itself (checking for referencing bookings rows
  when a flights row is deleted or its id changes is an indexed lookup, not
  a sequential scan) and any future "bookings for this flight" read — the
  same reason Day 26 added this index on SQLite, not speculatively.
```

## Test C — counter-proof numbers (Step 6)

```text
Naive reserveSeatNaive() (SELECT available_seats, check in TypeScript, sleep
30ms to widen the window, then UPDATE the computed value) run 20x
concurrently against a flight with 5 real seats, 3 runs in a row:

  run 1: 20/20 "reserved" (all 20 callers read the stale value before any
         UPDATE landed) — final available_seats = 4
  run 2: 20/20 "reserved" — final available_seats = 4
  run 3: 20/20 "reserved" — final available_seats = 4

Every run overbooked completely (20 successes against 5 real seats), and
every run's final seat count landed on 4, not 0 or negative — the lost
update anomaly: every racer computed "5 - 1 = 4" off the same stale read,
so whichever UPDATE lands last simply overwrites the others. Decided to
keep this test permanently (same reasoning as Day 37's counter-proof): it
protects against ever mistaking "the naive pattern happened not to race
this run" for "the naive pattern is safe."

Without the artificial delay, the same code would still race under load,
just non-deterministically — a single clean run would prove nothing (the
callers might simply not have overlapped that time), which is exactly why
the delay is there: to make the failure mode observable on demand instead
of dependent on machine timing.
```

## Delivered

```text
api/src/bookings/booking-repository.ts — port made async (4th conversion:
  Flight, Outbox, Audit, Booking)
api/src/bookings/sqlite-booking-repository.ts, create-booking.ts,
  cancel-booking.ts — async ripple, SQLite behavior unchanged
api/tests/sqlite-booking-repository.test.ts — awaited direct calls (was
  silently comparing Promises to plain objects via assert.deepEqual before
  the fix — passed typecheck but would have failed at runtime)
api/src/bookings/postgres/booking.entity.ts + migration
  1790436000000-CreateBookings.ts — FK (NO ACTION), idx_bookings_flight_id,
  strict status CHECK
api/src/bookings/postgres/postgres-booking-repository.ts —
  reserveSeat/releaseSeat compute in SQL (not TypeScript); cancel() uses
  RETURNING instead of a separate SELECT on the success path
api/src/postgres/data-source.ts — registers BookingEntity + migration
5 new integration test files: postgres-booking-repository (repository
  methods sequentially, incl. the FK-rejection case), create-booking.postgres
  and cancel-booking.postgres (real use case, full adapter set),
  postgres-booking-race (Test A overbooking, Test B double-cancel, Test C
  naive-SELECT-then-UPDATE counter-proof)
3 existing integration test files patched (CASCADE) after bookings' FK made
  their beforeEach TRUNCATEs fail
CLAUDE.md + docs/adr/004-optimistic-concurrency-control.md — the 2 Day 38
  rules recorded
```

## Verified end to end

```text
npm run typecheck / typecheck:test (root, all workspaces) -> clean
npm test (root) -> 176 (api) + 4 (flight-notifier) + 12 (identity) pass,
  same counts as before Day 39 — no silent test drop
npm run postgres:migration:run -> bookings table created in booking_db
\d bookings -> FK to flights (NO ACTION), idx_bookings_flight_id, strict
  status CHECK, loose passenger_name CHECK
npm run test:integration (--test-concurrency=1) -> 32/32 pass, 3 runs in a
  row with no flakiness (13 carried over through Day 37 + 2 Audit + 3
  CreateFlight from Day 38 + 6 booking-repository + 5 use-case + 3 race/
  counter-proof, all new today)
```

## Not today

```text
No cutover — bootstrap/application.ts still constructs Sqlite* repositories
  and SqliteTransactionRunner; production behavior unchanged
All 4 repositories (Flight, Outbox, Audit, Booking) are now dev-complete —
  Day 40 is the combined cutover per docs/migration-plan-postgres.md
  Section 5.2 (all 4 tables switch together, since they share one
  TransactionRunner.run() boundary — the reason Day 35 rejected migrating
  and cutting over one table at a time)
```

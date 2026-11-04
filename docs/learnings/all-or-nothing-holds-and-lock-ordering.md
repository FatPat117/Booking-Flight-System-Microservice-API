# All-or-nothing holds and lock ordering

## The problem it solves

A family books three seats. Either all three are held or none is (BR-SEAT-02) — half a family on
a plane is worse than a clear "no". With one seat per booking (Day 47) this was free: one row,
one `UPDATE`. With several rows, two things break:

1. **The half-commit.** Code that updates the seats it found and *then* notices it found too few
   returns `not-enough-seats` — and the use case's transaction commits, leaving those seats `HELD`
   by a booking that never gets inserted.
2. **Deadlock.** Alice asks for `[12A, 12B]`, Bob for `[12B, 12A]`. Alice locks `12A`, Bob locks
   `12B`, each waits for the other. Postgres aborts one with `40P01` after `deadlock_timeout` (1 s);
   the client sees a 500.

## How it works

`api/src/bookings/postgres/postgres-booking-repository.ts` — `holdAutoSeats` and
`holdChosenSeats`. Each hold is **one statement** of CTEs:

```text
lock the candidates → compute a verdict over them → UPDATE … WHERE verdict
```

- **The verdict is inside the writing statement.** `enough AS (SELECT count(*) = $n …)` and
  `UPDATE … FROM candidates, enough WHERE enough.ok`. Too few → the `UPDATE` matches nothing.
  Nothing to undo, so it does not matter whether the caller commits.
- **System-picked seats: `SKIP LOCKED`.** Seats are interchangeable; skip the ones another booking
  is taking right now. A skipping statement never waits, so it can never be in a lock cycle.
- **Chosen seats: wait, in a global order.** `ORDER BY seat.row, seat.letter FOR UPDATE OF seat`.
  Everyone locks `12A` before `12B` regardless of how the request listed them, so there is no
  cycle — the second request simply waits, then sees `12A` taken. No `SKIP LOCKED` here: skipping
  a seat the customer *named* would silently drop it.
- **Report which, never who.** The final `SELECT` returns every locked row with its status, so
  the error names the taken seats (`SEATS_UNAVAILABLE`, `details: ["12B"]`) without saying who
  holds them.

## Trade-offs / when NOT to use

- One clever statement is harder to read than three simple ones. It pays off only because
  correctness depends on the verdict and the write being atomic; for a single-row change a
  conditional `UPDATE` (ADR-004) is enough.
- `SKIP LOCKED` has an edge with multi-row picks: two holds racing for the *last* seats can each
  grab some and skip the other's, so both fail although one could have fit. Measured 0 in 200
  rounds; acceptable because a retry succeeds. If it mattered, the fix is waiting (no
  `SKIP LOCKED`) and paying with queues.
- Global lock ordering is a convention: every future statement that locks several seats (seat
  change, flight cancellation cascade, expiry job) must follow it, or the cycle comes back.

## Gotchas

- **The mutation that survived.** Removing `ORDER BY` left the race test green: the planner
  happened to dedupe the `IN (…)` list with `Unique` over `Sort (row, letter)`. Plans are not
  promises; the `ORDER BY` is. Ordering by the *request* position instead deadlocked at once —
  a single statement can deadlock with another single statement.
- **Timing alone deadlocks almost always.** The request-order control without any barrier
  deadlocked in 98 of 100 rounds: two requests that start together each take their first seat
  before the other asks for it. "Rare race" thinking would have been wrong.
- **Catching `23505` aborts the transaction.** The reference retry uses `ON CONFLICT … DO NOTHING
  RETURNING id` instead: empty result → redraw, transaction still usable, seats still held.
- **The deferred FK as a second net.** A half-committed hold points seats at a booking id that is
  never inserted; `FK_flight_seats_booking_id` (`DEFERRABLE INITIALLY DEFERRED`) rejects the COMMIT.
  Useful, but it turns a `409` into a `500` — the statement must refuse on its own.

## Day 50: a swap, and the snapshot of one statement

- **A seat change locks both seats in the global order.** The passenger's seat and the target are
  locked together, `ORDER BY row, letter FOR UPDATE`, whichever is "mine". Locking the own seat
  first lets `12A → 14C` and `14C → 12A` each hold one and wait for the other: the control
  deadlocked 5 rounds out of 5, the real change 0 in 10 (both answer `409 SEAT_UNAVAILABLE`).
- **A statement that waited for a lock still reads other rows from its own snapshot.** In READ
  COMMITTED the row an `UPDATE` waited for is re-checked, but every other row the statement reads
  comes from the snapshot taken when it started. The one-statement cancel released the booking's
  seats found by `booking_id` in that snapshot; waiting for a seat change, it released the old seat
  (already free) and left the new one `BOOKED` for a cancelled booking. The fix locks the booking
  in a statement of its own first, so the cancel statement starts after the change committed.
- **A lock taken "to be safe" changes who else gets the row.** The first version of that lock was
  unconditional; the expiry job's `SKIP LOCKED` sweep then skipped a lapsed hold that a cancel
  (about to answer `expired`) had locked. The lock now uses the cancel's own condition.
- **One function for the global invariants** (`api/tests/integration/invariants.ts`) ends every
  race test: seats ⇔ bookings, passengers ⇔ seats, fare classes, payments ⇔ bookings, and the
  provider's net money against the paid bookings — each check shown failing on data broken on
  purpose.

## Day 51: auditing every statement for the snapshot trap

**The rule.** A statement that can wait for a lock *and* then finds rows by a foreign key (seats
`WHERE booking_id IN (…)`) finds them as they were before the wait. It needs one of two things:

1. a pre-lock in a statement of its own, so the second statement starts after the wait (cancel,
   Day 50); or
2. an invariant that keeps the set fixed while it could wait — and a test that fails if the
   invariant goes away.

| Statement | Can wait for a lock? | Finds rows by a key whose set can change meanwhile? | Why it is safe |
|---|---|---|---|
| `holdAutoSeats` | flight/fares share locks only; seats `SKIP LOCKED` | no — `status = 'AVAILABLE'`, re-checked under the lock | a seat taken meanwhile is skipped |
| `holdChosenSeats` | yes (seats) | no — seats by primary key | the status is re-read on the locked row |
| `expireDueHolds` | seats only (bookings `SKIP LOCKED`) | seats by `booking_id` | **invariant**: a `HELD` booking's seats never change |
| `confirmHold` (SettlePayment) | yes (booking) | seats by `booking_id` | **invariant**, same one |
| `cancel` | yes (booking) | seats by `booking_id` | pre-lock statement (Day 50) |
| `changeSeat` | yes | no — separate statements, seats by primary key | each statement starts after the lock |

`api/tests/integration/postgres-snapshot-audit.integration.test.ts` races `confirmHold` against a
cancel and a refused seat change (both correct), and adds a **control**: a test-only writer that moves
a `HELD` booking's seat. The queued confirm then finds the old seat in its snapshot, books nothing,
and leaves the new seat `HELD` for a `CONFIRMED` booking — caught by the invariants. Allowing a seat
change on `HELD` bookings would need a pre-lock in `confirmHold` first.

## Related

ADR-004 addenda (Day 47 `SKIP LOCKED`, Day 48A lock order); domain-model Decision 11;
`.cursor/progress/DAY-48A.md`; race tests in
`api/tests/integration/postgres-booking-hold-race.integration.test.ts`,
`api/tests/integration/postgres-seat-change-race.integration.test.ts` (Day 50, Decision 16);
[exclusion-constraints.md](./exclusion-constraints.md) (the other `40P01` in this codebase).

# CURRENT PROGRESS

**Last completed day:** Day 48B
**Current day:** Day 48B — Hold expiry job, expiry vs cancel race (phase D step 5, part 2)
**Status:** ✅ Complete — unit 377/377, flight-notifier 10/10, identity 12/12, integration
140/140, expiry race file 10× in a row, end-to-end verified (HTTP + psql + app/notifier logs +
newman). A `HELD` booking expires at `holdExpiresAt`: `booking-hold-expiry-job` (60 s, batches
of 50 with `FOR UPDATE SKIP LOCKED`, at most 20 per run) marks it `EXPIRED`, frees its seats and
writes a `BOOKING_EXPIRED` audit entry (actor `system/booking-hold-expiry`) and a
`booking-expired` event (contract + notifier consumer). Reads show `EXPIRED` from the deadline
on; cancel checks the deadline in its own `WHERE` → `409 BOOKING_EXPIRED`. Boundary BR-BOOK-10:
`<= now` expired, `> now` valid. Cancel and expiry release seats through one ordered-lock CTE,
removing a deadlock with chosen-seat holds. `JobScheduler.stop()` waits for a running job.

## Day 48B delivered

```text
Step 0: Day 48A leftovers — ORDER BY comment on the line; SKIP LOCKED multi-seat edge accepted
  (Decision 11 bullet)
Step 1: domain-model Decision 12 (hybrid expiry, expired wins, event, 60 s / 50 / 20, constant
  duration, system actor), BR-BOOK-10, lock-order table — found the unordered-release deadlock
Step 2: AddBookingHoldExpiryIndex (hold_expires_at, id) WHERE HELD; EXPLAIN 104 vs 2 990
  buffers; plan test
Step 3: expireDueHolds (port, Postgres CTE, fake), contract +5
Step 4: system audit actor, booking-expired contract + consumer, ExpireHolds, job, stop() awaits
Step 5: effective status on read, cancel with the deadline + releaseSeatsOf, 409 BOOKING_EXPIRED
Step 6: race tests A–F (+ controls; gate transaction for E), mutations, e2e, Postman, README,
  ADR-004 addendum, learnings (EN + VI)
```

## Previous day (Day 48A) recap

```text
1–9 passengers per booking, held all-or-nothing in one statement for 15 minutes; chosen seats
locked in (row, letter) order; 6-character reference; booking-held event.
```

## Next

Day 49 — Phase D step 6: simulated payment with an Idempotency-Key (US-PAY-01, BR-PAY-*).
`HELD → CONFIRMED` takes the `> now` side of BR-BOOK-10, seats `HELD → BOOKED` in the same
transaction, and gets the payment-vs-expiry race test. Per
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried (see DAY-48B "Not today"): BR-BOOK-03 pricing, removing the
`booking-created` contract once its queue is empty, the release `ORDER BY` survivor, the
outbox relay not being multi-instance safe.

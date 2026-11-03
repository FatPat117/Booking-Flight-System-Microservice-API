# Day 50 — Cancellation policy and seat change (phase D, step 7)

> ✅ Complete (2026-11-03). Unit 532/532, integration 234/234 (on `booking_test`), notifier 19/19,
> identity 12/12 + integration 7/7 (on `identity_test`); typecheck clean; seat-change race file 10×
> in a row; e2e on docker compose (HTTP + psql + app and notifier logs, 6 scenarios); Postman Day 50
> folder via newman 11/11.

## What and why

Before today, cancelling a `CONFIRMED` booking released its seats and left its payment `SUCCEEDED`:
the money stayed taken for a booking that no longer stood, breaking Day 49C's money invariant. BR-BOOK-06
(no cancel within 24 h of departure) and BR-BOOK-07 (seat change within the fare class) were the
last two rules of phase D step 7. Three items from the Day 49C review came first.

## Decisions made with the student

| Question | Choice |
|---|---|
| Exactly 24 h before departure | Already closed: cancellable while `departure_at − 24 h > now` (the BR-BOOK-10 shape) |
| Seat change for `HELD` bookings | No, `CONFIRMED` only, as BR-BOOK-07 says (`409 BOOKING_NOT_CHANGEABLE`) |
| `booking-cancelled` consumer | Today: contract in `packages/contracts` with `refund`, consumer in flight-notifier |
| Defaults proposed and kept | Refund through `REFUND_PENDING` and the reconciliation job; cancel answers `200 { booking, refund }`; `PUT …/passengers/:position/seat`, one passenger per request; "on sale" = the hold's sales window |
| Code-writing permission | Confirmed for this session, first person |

## Step 0 — Three items left from Day 49C

- **Identity's `_test` guard.** `IDENTITY_POSTGRES_DB` (default `identity_db`),
  `test:integration` sets `identity_test` and preloads `require-test-database.ts`;
  `docker/postgres-init/03-create-identity-test-db.sh`, created once by hand on the existing volume.
  Proven: pointed at `identity_db`, the run refused before any test, `users` 12 → 12.
- **Payment timings checked at startup.** `PAYMENT_RECONCILIATION_MARGIN_MS` became configuration
  (default 30 000); `parseConfig` refuses `margin < 5 s` (settle budget) and `timeout + margin ≥ 60 s`
  (BR-PAY-07), naming the inequality and the values. Proven by starting the app with 1000 and 50 000.
- **Concurrent gateway calls:** bounded by `batchSize` (20 per instance); no limiter, written in
  Decision 15 and the README limitations.

## Step 1 — Decision 16

Domain-model Decision 16, BR-BOOK-06/07 rewritten as exact boundaries, Payment
`SUCCEEDED → REFUND_PENDING`, Booking `CONFIRMED → CONFIRMED` (seat change), two lock-order rows
(cancel with payment; seat change). Pause & Think answered: expiry releases by
`flight_seats.booking_id`, not a stored list, so it would free the new seat.

## Step 2 — Cancelling a `CONFIRMED` booking

The cancel statement checks the 24 h window against the flight's departure under `FOR SHARE`; the
use case moves the `SUCCEEDED` payment to `REFUND_PENDING` (due now) in the same transaction, audits
`PAYMENT_REFUND_PENDING`, and the event carries `refund`. The route answers `200` (was `204`) or
`409 CANCELLATION_WINDOW_CLOSED` with `cancellableUntil`. No gateway call in the cancel flow.
`booking-cancelled` contract + `booking_cancelled_consumed`. Mutation `>` → `>=` caught by the
Postgres contract; fault injection (process gone after the cancel, first refund attempt dies): a
new runtime's job refunds once.

## Step 3 — Seat change

`PUT /api/bookings/:id/passengers/:position/seat`, `ChangeSeat` + `BookingRepository.changeSeat`.
One transaction, three lock statements in the global order (flight share + booking, passenger, both
seats `ORDER BY row, letter`), the verdict read under the lock, then the writes. Nine outcomes, the
same order of checks in Postgres and the fake. `unchanged` writes nothing (naturally idempotent, no
Idempotency-Key). Mutation (no fare-class check) caught by the Postgres contract.

## Step 4 — Global invariants

`api/tests/integration/invariants.ts`: seats ⇔ bookings, passengers ⇔ their seat, one seat per live
passenger, fare classes, `SUCCEEDED` ⇒ `CONFIRMED`, a cancelled charged booking is being refunded,
and money against the provider's ledger (net kept = paid `CONFIRMED` totals, after what is owed back).
Ten tests: a clean world, then each kind of corruption on purpose. The three earlier race files call
it; a probe (always one violation) failed 27 of their 29 tests (the 2 are controls).

## Step 5 — Races (Postgres, 10× in a row)

| Test | Result |
| --- | --- |
| A — crosswise swap, gated, 10 rounds | 0 deadlocks, 20/20 `seat-unavailable` |
| A' — own seat first (control) | 5/5 `40P01` |
| B — change vs new hold on 14C | exactly one wins (change 0–1, hold 9–10 per run) |
| C — cancel vs change, same booking | both orders seen; the cancelled booking owns no seat |
| C forced / C' | the fix releases the new seat; the one-statement cancel left it `BOOKED` |
| D — 24 h boundary | exact instant refused, 1 ms earlier cancels |
| E — change then cancel; `HELD` change; expiry | new seat released, old free; `HELD` refused; expiry frees its seat |
| F — 10 paid cancels with two reconciliation runs | 10 refunds, one per payment |

**Found by race test C:** in READ COMMITTED a statement reads the snapshot taken when it started.
The one-statement cancel (Day 48B) waited for a seat change on the booking row, then released the
seats found by `booking_id` in its old snapshot — the old seat, already free — and left the new seat
`BOOKED` for a `CANCELLED` booking. Cancel now locks the booking (and share-locks the flight) in a
statement of its own first. The first version locked unconditionally and broke the Day 48B race
test C (expiry's `SKIP LOCKED` skipped a lapsed hold a cancel had locked); the lock now uses the
cancel's own condition. Mutation (no pre-lock) fails C forced.

## Step 6 — E2E and docs

App and notifier rebuilt (no migration today). Tokens signed with the shared `JWT_SECRET`.

```text
setup  VN-A321 flight, booking on 3A, paid               → SUCCEEDED
3. PUT seat 3F (economy)       → 200, price 1 500 000 unchanged, map 3A AVAILABLE / 3F BOOKED, 1 audit
4. same PUT again              → 200, identical body, still 1 audit
5. PUT a BUSINESS seat         → 409 FARE_CLASS_MISMATCH "ECONOMY, not BUSINESS"
6. Bob on Alice's booking      → 404 BOOKING_NOT_FOUND
1. DELETE the paid booking     → 200 in 11 ms, CANCELLED, refund REFUND_PENDING; seats free;
                                 REFUNDED 4 s later (payments_reconciled refunded 1);
                                 notifier booking_cancelled_consumed with the refund's payment id
2. departure_at → now + 23 h (psql), DELETE → 409 CANCELLATION_WINDOW_CLOSED,
                                 cancellableUntil = departure_at − 24 h; still CONFIRMED / SUCCEEDED / BOOKED
audit: BOOKING_CREATED, BOOKING_CONFIRMED, BOOKING_SEAT_CHANGED, BOOKING_CANCELLED,
       PAYMENT_REFUND_PENDING (owner), PAYMENT_REFUNDED (system/payment-reconciliation)
DLQ:   14 pre-Day 50 booking-cancelled messages rejected into booking-cancelled.dlq, as Decision 16 expected
```

Docs: README (route table, cancel answer, new Day 50 section, audit rows, notifier, limitations),
Postman **Day 50 — Cancellation and seat change** (11 requests, newman 11/11) and the three requests
that expected `204`, `postman/README.md` step 19, domain-model (Decision 16, BR-BOOK-06/07 ✅, step 7
done), learnings `all-or-nothing-holds-and-lock-ordering.md`, Vietnamese notes.

## Incidents

- The dev stack's `postgres` and `rabbitmq` had stopped a day earlier and `app` was restarting; started
  again on the same volume, no data lost.
- Mistakes of mine caught by the tests: the cancel follow-up read used `$3` with two parameters
  (Postgres, not the fake); a contract test changed a seat to `6F` on a 30-seat flight and never
  checked the result; an unconditional pre-lock that changed the expiry job's behaviour.
- One unit test failed once in a full run without its name being kept; nine runs after that were
  green. Suspected: a test with a real-time window (the simulator timeout test, 50–200 ms) under load.
- The Bookings, Day 47 and Day 48A Postman requests (now `200`) were not re-run: their folders create
  fixed flights that already exist on the dev database.

## Test count reconciliation

```text
Unit (api):   494 (Day 49C) + 6 (config: margin values, two boundaries)             = 500  Step 0
              + 6 (cancel-booking) + 2 (booking-lifecycle) + 2 (HTTP)
              + 3 (booking contract) + 2 (payment contract)                          = 515  Step 2
              + 9 (booking contract: changeSeat) + 4 (change-seat) + 4 (HTTP)        = 532  Step 3
Integration:  199 + 5 (contracts on Postgres) + 2 (reconciliation: paid cancel, fault) = 206  Step 2
              + 9 (booking contract: changeSeat)                                     = 215  Step 3
              + 10 (invariants)                                                      = 225  Step 4
              + 9 (seat-change races)                                                = 234  Step 5
Notifier: 16 + 3 = 19.   Identity: 12 unit; integration 5 + 2 = 7.
```

## Not today

- A customer cannot learn that a refund finished: no `GET` for a payment, no `payment-refunded` event.
- Seat change: one passenger per request; no swap between two passengers of one booking; no change
  across fare classes (needs a difference payment or partial refund).
- The HTTP tier cannot test `FARE_CLASS_MISMATCH`: the fake flight store ignores a registered layout
  (covered by the contract on both tiers and by e2e).
- Carried: `REFUND_FAILED` has no endpoint or alert; the simulator's provider memory is in-process;
  the outbox relay is not multi-instance safe and consumers do not dedupe by `eventId`; no
  fare-change endpoint; deprecated `priceInCents`; removing the `booking-created` contract; the
  release `ORDER BY` survivor.

## DAY 50 SUMMARY

A paid booking can now be cancelled more than 24 hours before departure, and its money comes back
through the path Day 49C already proved: the cancel moves the payment to `REFUND_PENDING` in its own
transaction and the reconciliation job refunds it, so no request waits on a gateway and no booking is
cancelled with its money kept. A passenger can change seats within their fare class with a `PUT`
that is idempotent by design; both seats are locked in the global order, so a crosswise swap queues
instead of deadlocking (0 vs 5/5). The races found a real bug in the Day 48B cancel — a statement's
snapshot predating the seat change it waited for — fixed with a lock taken first, conditionally so
the expiry job keeps its behaviour. One global invariant function, proven on broken data, now ends
every race test.

**Suggested commit message:**

```text
feat(api): cancellation policy and seat change — a paid CONFIRMED booking cancelled more than 24 h before departure is refunded through reconciliation, and a passenger changes seats within the fare class in one ordered swap - BR-BOOK-06 in the cancel statement (departure_at − 24 h > now, flight FOR SHARE; 409 CANCELLATION_WINDOW_CLOSED with cancellableUntil), SUCCEEDED → REFUND_PENDING in the same transaction, no gateway call in the request, cancel answers 200 { booking, refund }; booking-cancelled contract + flight-notifier consumer (pre-Day 50 messages to the DLQ); PUT /api/bookings/:id/passengers/:position/seat (CONFIRMED only, same class, on sale; both seats locked in (row, letter) order, verdict under the lock, price snapshot unchanged, naturally idempotent, BOOKING_SEAT_CHANGED); cancel locks the booking in a statement of its own first, conditionally (race test C: the one-statement cancel released seats from its old snapshot); identity integration tests on identity_test behind a guard; payment timing inequalities checked at startup (PAYMENT_RECONCILIATION_MARGIN_MS); global invariants in tests/integration/invariants.ts proven on broken data; races A–F with controls A' (5/5 deadlocks) and C', e2e, Postman Day 50; Decision 16

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

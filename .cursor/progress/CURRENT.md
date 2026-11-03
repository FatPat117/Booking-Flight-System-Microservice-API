# CURRENT PROGRESS

**Last completed day:** Day 50
**Current day:** Day 50 — Cancellation policy and seat change (phase D step 7)
**Status:** ✅ Complete — unit 532/532, notifier 19/19, identity 12/12 + integration 7/7 (on
`identity_test`), integration 234/234 (on `booking_test`), seat-change race file 10× in a row,
end-to-end verified (HTTP + psql + app/notifier logs + newman Day 50 11/11). A `CONFIRMED` booking is
cancellable while `departure_at − 24 h > now` (BR-BOOK-06), checked in the cancel statement under a
flight share lock; cancelling a paid one moves its payment to `REFUND_PENDING` in the same
transaction and the reconciliation job refunds it (no gateway call in the request). `booking-cancelled`
has a contract and a consumer. A passenger changes seats within the fare class with
`PUT /api/bookings/:id/passengers/:position/seat` (BR-BOOK-07): both seats locked in `(row, letter)`
order, naturally idempotent. Race test C found the one-statement cancel releasing seats from a stale
snapshot; cancel now locks the booking first (Decision 16).

## Day 50 delivered

```text
Step 0: identity_test + guard; payment timings checked at startup (PAYMENT_RECONCILIATION_MARGIN_MS);
  gateway concurrency bounded by the batch (limitations)
Step 1: Decision 16, BR-BOOK-06/07 exact, Payment SUCCEEDED → REFUND_PENDING, lock-order rows
Step 2: cancel CONFIRMED: 24 h window, refund via REFUND_PENDING, 200 { booking, refund },
  booking-cancelled contract + consumer
Step 3: seat change: PUT …/passengers/:position/seat, ordered two-seat lock, nine outcomes
Step 4: tests/integration/invariants.ts, each check proven on broken data
Step 5: races A–F + controls A' (5/5 deadlocks) and C'; cancel's pre-lock fix — 10×
Step 6: e2e 6 scenarios, Postman Day 50 (newman 11/11), README, learnings (EN + VI)
```

## Previous day (Day 49C) recap

```text
Unknown gateway outcomes answered 202 and finished by a reconciliation job (re-charge with the same
payment id, lease in next_attempt_at); refunds only in the job; Idempotency-Key cleanup after 24 h;
integration tests on booking_test behind a guard.
```

## Next

Day 51 — Phase D step 8: flight search + details with availability (US-FLT-04/05): by route, date
range and passenger count, sorted and paginated — where the deep-`OFFSET` numbers measured on Day 47
become a real decision. Per [`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried (see DAY-50 "Not today"): no way to learn a refund finished; seat change one
passenger at a time, no swap inside a booking; `REFUND_FAILED` has no endpoint or alert; the
simulator's provider memory is in-process; the outbox relay is not multi-instance safe and consumers
do not dedupe by `eventId`; no fare-change endpoint, deprecated `priceInCents`, removing the
`booking-created` contract, the release `ORDER BY` survivor.

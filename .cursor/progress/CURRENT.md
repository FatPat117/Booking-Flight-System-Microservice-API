# CURRENT PROGRESS

**Last completed day:** Day 49B
**Current day:** Day 49B — Simulated payment with an Idempotency-Key, `HELD → CONFIRMED` (phase D step 6b)
**Status:** ✅ Complete — unit 459/459, flight-notifier 16/16, identity 12/12, integration
181/181, payment race file 10× in a row, end-to-end verified (HTTP + psql + app/notifier logs +
queues + newman). `POST /api/bookings/:id/payments` charges `booking.total` through a simulated
gateway called **outside any transaction** (ADR-009): phase 1 claims the Idempotency-Key and records
a `PROCESSING` payment, phase 2 charges, phase 3 confirms (`HELD → CONFIRMED`, seats `BOOKED`,
`booking-confirmed`) with BR-BOOK-10's `> now`, or — when the booking expired or was cancelled
meanwhile — records `REFUND_PENDING`, commits, refunds, records `REFUNDED`. A payment starts only
with more than 60 s left (BR-PAY-07). Final answers are stored with the key (`json`, replayed byte
for byte with `Idempotent-Replayed: true`); one `PROCESSING` and one `SUCCEEDED` payment per booking
(partial unique indexes).

## Day 49B delivered

```text
Step 0: lock order table — fare share lock on holds, new "confirm payment" row
Step 1: domain-model Decision 14, Payment lifecycle (PROCESSING … REFUNDED), BR-PAY-07, ADR-009
Step 2: CreatePayments / CreateIdempotencyKeys (refused on dev data until BUSINESS fares set by hand)
Step 3: PaymentGateway port, simulator (PAYMENT_SIMULATOR_DELAY_MS), scripted fake
Step 4: requestFingerprint, IdempotencyRepository (+ Postgres, fake, contract, concurrency tests)
Step 5: PaymentRepository, BookingRepository.confirmHold (updateSeatsOf), createPayForBooking,
  payment-response, audit actions, booking-confirmed contract + notifier consumer, wiring
Step 6: route POST /api/bookings/:id/payments (header + body validated before the claim)
Step 7: race tests A–E (+ C at the deadline) 10×, e2e 6 scenarios (found jsonb reordering keys →
  json), Postman Day 49B folder (newman 13/13), README, learnings (EN + VI), BR-PAY-01..07 ✅
```

## Previous day (Day 49A) recap

```text
Fares: Money in whole đồng, one fare per fare class (BR-FLT-09), the hold copies each seat's fare
FOR SHARE (BR-BOOK-03), Booking.total derived.
```

## Next

Day 49C — Phase D step 6c: payment failures. A gateway call of unknown outcome (timeout, crash after
phase 1) leaves a payment `PROCESSING` and its key `IN_PROGRESS`; a refused refund leaves
`REFUND_PENDING`; Idempotency-Keys are never cleaned up (24 h). Reconciliation finishes them, using
the payment id the gateway already received as its idempotency key. Per
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried (see DAY-49B "Not today"): **a separate test database** (integration tests
`TRUNCATE` dev data, and a running `app`'s expiry job sweeps test bookings — both happened on Day
49B), no fare-change endpoint, deprecated `priceInCents`, removing the `booking-created` contract,
the release `ORDER BY` survivor, the outbox relay not being multi-instance safe.

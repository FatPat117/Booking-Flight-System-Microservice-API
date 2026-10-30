# CURRENT PROGRESS

**Last completed day:** Day 49C
**Current day:** Day 49C — Payment failures: unknown outcomes, reconciliation, key cleanup (phase D step 6c)
**Status:** ✅ Complete — unit 494/494, flight-notifier 16/16, identity 12/12, integration
199/199 (on `booking_test`, dev `app` running), reconciliation file 10× in a row, end-to-end
verified (HTTP + psql + app/notifier logs + newman Day 49C 8/8, Day 49B 13/13). A gateway call is
charged, declined or **unknown**: the adapter cuts it at `PAYMENT_GATEWAY_TIMEOUT_MS` and the request
answers `202` with the payment still `PROCESSING`, never `FAILED` (BR-PAY-08). The
`payment-reconciliation-job` leases due payments (`next_attempt_at`, `SKIP LOCKED`), charges them
again with the same payment id and settles them with the request's own phase 3 (`SettlePayment`);
refunds run only there, 1/2/4/8 min apart, then `REFUND_FAILED` for a person (BR-PAY-09). The
`idempotency-key-cleanup-job` deletes `COMPLETED` keys after 24 h (BR-PAY-10). Integration tests run
on `booking_test` behind a preloaded `_test` guard.

## Day 49C delivered

```text
Step 0: BOOKING_POSTGRES_DB, booking_test (init script + one-off command), require-test-database guard
Step 1: Decision 15, Payment lifecycle (REFUND_FAILED), lock order rows, BR-PAY-08..10, ADR-010
Step 2: gateway unknown outcome + retryable refunds; simulator timeout and four failure tokens; fake
  with provider memory and a ledger
Step 3: AddPaymentReconciliation; request answers 202 on unknown, no refund in the request
Step 4: SettlePayment shared by request and job; claimDue / reschedule / completeForPayment;
  ReconcilePayments + payment-reconciliation-job
Step 5: deleteCompletedBefore, CleanupIdempotencyKeys + idempotency-key-cleanup-job
Step 6: fault injection (scenarios 1–6 + 3b) with a global money invariant; request-vs-job race,
  two-instance race and a no-lease control (30 duplicate calls vs 0); cleanup; EXPLAIN — 10×
Step 7: e2e 7 scenarios, Postman Day 49C (newman 8/8), README, learnings (EN + VI), BR-PAY-08..10 ✅
```

## Previous day (Day 49B) recap

```text
Payment in three phases around a simulated gateway, never inside a transaction (ADR-009); an
Idempotency-Key with a fingerprint and the final answer stored as json; partial unique indexes for
one PROCESSING / one SUCCEEDED payment per booking.
```

## Next

Day 50 — Phase D step 7: cancellation policy + seat change (US-BOOK-05/06, BR-BOOK-06/07): the 24 h
rule for cancelling a `CONFIRMED` booking, and changing a seat within the same fare class while the
flight is `OPEN`. Per [`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried (see DAY-49C "Not today"): identity's integration tests still `TRUNCATE`
`identity_db`; the outbox relay is not multi-instance safe and consumers do not dedupe by `eventId`;
`booking-cancelled` has no consumer; `REFUND_FAILED` has no endpoint or alert; the simulator's
provider memory is in-process; no fare-change endpoint, deprecated `priceInCents`, removing the
`booking-created` contract, the release `ORDER BY` survivor.

# Payments: external calls outside transactions, and Idempotency-Keys

## The problem it solves

Day 49B makes a `HELD` booking `CONFIRMED` by charging a payment gateway. Two things are new and
both are hard:

1. **A call to another system in the middle of a write.** The gateway may take seconds, may fail
   after it took the money, and cannot be rolled back by `ROLLBACK`.
2. **Clients repeat requests.** A mobile app on a bad connection, a double click, a proxy retrying
   a timeout: the same "pay" arrives twice. Paying twice is the worst bug a booking system can have.

## How it works

### Three phases around the gateway (ADR-009)

`api/src/payments/pay-for-booking.ts` — `createPayForBooking`.

1. **Phase 1, short transaction:** claim the Idempotency-Key, read the booking (owner scope,
   `HELD`, more than 60 s left, amount = total), insert a `PROCESSING` payment, link it to the key.
2. **Phase 2, no transaction:** `gateway.charge({ paymentId, amount, token })`. Nothing is locked.
3. **Phase 3, short transaction:** record the outcome and store the response with the key.
   Charged → `confirmHold` (`HELD → CONFIRMED`, seats `HELD → BOOKED`, one statement) +
   `SUCCEEDED` + `booking-confirmed` in the outbox. Declined → `FAILED`, booking stays `HELD`.

Why not one transaction around everything — the obvious version? Race test E measured it with a
1 s charge: a cancel of that booking **waited 908–922 ms** for the booking row lock, and the expiry
job, which takes rows `FOR UPDATE SKIP LOCKED`, **skipped** the booking instead of expiring it.
With three phases the same cancel took 2–11 ms. A transaction held open across a network call also
holds a pool connection per paying customer, and rolling it back does not return any money.

### Compensation: when phase 3 loses the race

Between phase 1 and phase 3 the booking can expire or be cancelled — the gateway has the money and
the booking is gone. Phase 3 decides with the same conditional `UPDATE … WHERE status = 'HELD' AND
hold_expires_at > $now` that cancel uses (BR-BOOK-10). If it matches nothing:

1. mark the payment `REFUND_PENDING` and **commit**,
2. call `gateway.refund` outside any transaction,
3. a short transaction marks it `REFUNDED` (audit actor `system/payment-refund`).

**Write the intention before the side effect.** If the process dies after step 1, a row says "this
charge must be refunded" and reconciliation (49C) can finish it. The other order — refund, then
write — can leave money returned while the database still says the payment stands, with nothing
pointing at it. Same reasoning as the outbox: the database row is the durable promise.

To make refunds rare, a payment only *starts* with more than 60 s left on the hold (BR-PAY-07).
Freezing expiry while a payment is in flight would avoid them entirely, but it couples the Day 48B
sweep to payments and, until 49C exists, a crash after phase 1 would keep the seats forever.

### Idempotency-Key

`api/src/idempotency/` — port, Postgres adapter, `requestFingerprint`.

- **Claim = `INSERT … ON CONFLICT DO NOTHING`** on `(account_id, operation, key)`. A second claim
  of a key whose first insert is not committed **waits** for that transaction, then sees the row
  (or inserts, if the first rolled back) — no `23505`, so the caller's transaction stays usable.
  Race test A: 10 requests with one key → 1 charge, one `201`, nine `409 IDEMPOTENCY_KEY_IN_PROGRESS`.
- **Fingerprint** = SHA-256 of canonical JSON of `{ method, path, validated body }`, object keys
  sorted, array order kept. Same key + other fingerprint → `422 IDEMPOTENCY_KEY_REUSED`. Built from
  the *validated* body, so a field the server ignores does not make a repeat look new.
- **The response is stored in the same transaction as the outcome**, so a `COMPLETED` key never
  disagrees with the data. Only final business answers are stored (`201`, `402`, `409` not payable,
  `404`). Validation errors, amount mismatch, "another payment in progress" and every `5xx` are
  not: the client may retry with the same key.
- **Scope includes the account.** Two customers who both send `key-1` never see each other's answer
  (the Day 44 rule: every lookup carries the owner).
- **A key stops a *repeated* request, not two different ones.** Two tabs with two keys are stopped
  by the database: partial unique indexes allow one `PROCESSING` and one `SUCCEEDED` payment per
  booking (`ON CONFLICT ("booking_id") WHERE "status" = 'PROCESSING' DO NOTHING` names the partial
  index as the arbiter by repeating its predicate).

### Unknown outcome: keep the key

If `charge` throws (timeout, connection reset), the money may or may not have moved. Releasing the
key would let the retry charge again. So the payment stays `PROCESSING` and the key `IN_PROGRESS`;
the payment's own id goes to the gateway as *its* idempotency key, which is what makes a later
retry or reconciliation safe (49C).

## Trade-offs / when NOT to use

- Three phases cost code: three small transactions, a compensation path and a state
  (`PROCESSING`) a single transaction would not need. For a call that is local and fast (a cache,
  an in-process function) one transaction is simpler and fine.
- On Day 49B the refund ran inside the paying request after the commit: a slow refund delayed that
  request's `409` (8 s simulator delay → 16 s answer in the e2e). Day 49C moved it to the
  reconciliation job (below): the `409` now takes only the charge.
- Idempotency-Keys are needed where a repeat is *harmful* (money, emails, external side effects).
  A `GET`, or a `PUT` that sets a value, is already idempotent.

## Day 49C — when the gateway does not answer

A call has three results: charged, declined, **unknown**. Unknown (timeout, reset connection,
crash right after sending) means the provider may have charged, may not have, or may still charge
when a delayed request lands. Calling it a failure lets the customer pay again: charged twice.
So:

- **The adapter owns the timeout** (`AbortController`, `PAYMENT_GATEWAY_TIMEOUT_MS`) and returns
  `{ outcome: "unknown" }` as a value. The request answers `202`, stores nothing, keeps the key
  `IN_PROGRESS`. A `catch` around the charge that turns every error into `FAILED` is the worst bug
  this design can have.
- **Reconciliation charges again with the same payment id.** The id is the provider's idempotency
  key, so the second call returns the first charge or makes it now; afterwards there is exactly one
  result. Only *asking* ("what happened to this id?") is weaker: "not found" can be followed by a
  delayed request that charges. Cost: the payment keeps its payment-method token while
  `PROCESSING` (cleared on every transition out, enforced by a CHECK).
- **One column, three jobs.** `next_attempt_at` is the age gate (phase 1 sets it to timeout + 30 s,
  past the live request), the lease (the claim moves it forward before committing, so a second
  instance skips the row while the gateway call runs outside any transaction) and the backoff.
  `SKIP LOCKED` alone is not enough once the claim has committed: the control test without the
  lease made 30 duplicate gateway calls on 30 payments; with it, 0.
- **One phase 3.** `SettlePayment` is shared by the request and the job; the key is completed by
  `payment_id`, the only thing the job knows. A transition that finds the payment already moved
  throws and rolls back everything, booking confirmation included.
- **Bounded refunds, and a state for people.** 1, 2, 4, 8 minutes, then `REFUND_FAILED` + an error
  log — the dead-letter idea applied to money. `PROCESSING` never gets such an end: its outcome is
  unknown, and any terminal state would be a guess.
- **Keys expire, invariants do not.** After 24 h a `COMPLETED` key is deleted; the same request is
  then refused by the `CONFIRMED` booking and `UQ_payments_booking_succeeded`, not by the key.
- **Verified by fault injection**, one place per test (after phase 1, during the charge, lost
  answer, after `REFUND_PENDING`, refunds failing), each ending on one global invariant checked
  against the fake provider's ledger: money taken ⇔ `SUCCEEDED` + `CONFIRMED`, or refunded, or
  `REFUND_FAILED`.

## Gotchas

- **`jsonb` reorders keys.** The stored response was first `jsonb`; the e2e found the replayed body
  differed byte for byte (`details` sorted before `message`). The contract test compared with
  `deepEqual`, which ignores key order, so it passed. Now `json` (stored as written) and the test
  compares `JSON.stringify`. Pick `jsonb` to query inside a document, `json` to give it back as is.
- **A fingerprint without the path** would replay booking A's answer for booking B with the same key
  string. Race test B hit this when its rounds reused keys; the route includes the path.
- **Status codes in a use case.** The stored response must exist inside phase 3's transaction, before
  the route runs, so one module (`payment-response.ts`) maps final outcomes to `{ status, body }`.
  It is the only place outside `app.ts` that knows HTTP codes, and it says why.
- **The lock order still matters.** Phase 3 locks booking → seats → payment → idempotency row;
  confirm locks seats with the same `(flight_id, row, letter)` CTE as cancel and expiry
  (`updateSeatsOf`), or it could deadlock with a chosen-seat hold.

## Related

ADR-009, ADR-010, domain-model Decisions 14–15 and BR-PAY-01..10, Day 49B and 49C logs, race tests in
`api/tests/integration/postgres-payment-race.integration.test.ts` and
`api/tests/integration/postgres-payment-reconciliation.integration.test.ts`;
[hold-expiry-and-time-boundaries.md](./hold-expiry-and-time-boundaries.md),
[outbox-and-relay.md](./outbox-and-relay.md).

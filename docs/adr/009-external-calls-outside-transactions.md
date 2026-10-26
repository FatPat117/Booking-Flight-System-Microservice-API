# ADR-009: External Calls Stay Outside Database Transactions — Three-Phase Payment with Compensation

## Status

Accepted (Day 49B)

## Context

Paying for a held booking (US-PAY-01) means asking a payment gateway to take money, then confirming the booking (`HELD → CONFIRMED`, seats `HELD → BOOKED`). The gateway is a separate system. Today it is a simulator running in the `api` process; the design must still be the one a real provider (seconds of latency, timeouts, no shared transaction) would need, or 49C and phase F would have to redo it.

The natural first version — open a transaction, lock the booking, call the gateway, confirm, commit — has three problems:

- **Locks are held across the network.** The booking row and its seat rows stay locked for as long as the provider takes. An owner's cancel waits behind it. The expiry job uses `SKIP LOCKED`, so it does not wait: it silently skips the booking for that run.
- **The connection pool drains.** Each customer waiting on the gateway holds a pool connection. Ten concurrent payments with a pool of ten stop every other request.
- **A rollback cannot return money.** If the transaction fails after the gateway charged, the database returns to its previous state and the customer's money stays taken. A database transaction has no authority outside the database.

Day 43 had modelled Payment without a pending state, on the assumption that the simulator answers inside the transaction.

## Decision

A call to a system outside the database is never made inside a database transaction. Payment runs in three phases: a short transaction records a `PROCESSING` payment (and claims the Idempotency-Key); the gateway is called with no transaction open; a second short transaction records the outcome and, on success, confirms the booking with the same conditional `UPDATE` as cancel and expiry (ADR-004, BR-BOOK-10). When the gateway charged but the booking can no longer be confirmed, the payment is recorded as `REFUND_PENDING` and committed **before** the gateway is asked to refund — a compensating action, recorded before it is attempted.

## Consequences

**Positive**

- No row lock and no pool connection is held while the gateway works. Race test E measures the difference (a cancel waits for the whole charge with the in-transaction version, not with this one).
- Expiry and cancel stay unaware of payments: the race is decided by one conditional `UPDATE` at phase 3, as before.
- Every external effect leaves a durable trace first (`PROCESSING`, `REFUND_PENDING`), so a crash between phases can be found and finished by reconciliation (49C) instead of being lost.
- It is the smallest instance of the saga idea that phase F will need: each step that succeeded has a recorded undo for when a later step fails.

**Trade-offs / costs**

- **More states and more code paths.** `PROCESSING` and `REFUND_PENDING` exist only because of the gap between phases, and each path (declined, confirmed, lost the race, refund failed) needs its own test.
- **A customer can be charged and refunded.** If the hold expires or is cancelled while the gateway charges, the money goes out and comes back. A 60-second margin at phase 1 (BR-PAY-07) makes this rare; it cannot make it impossible.
- **Some outcomes are not final until 49C.** A crash after phase 1, a gateway error with an unknown result, or a failed refund leaves a payment `PROCESSING` or `REFUND_PENDING` with nothing to move it on until reconciliation exists.
- **Idempotency becomes mandatory.** Once a request can be "in progress" for seconds, a client retry is normal behaviour, so the endpoint requires an Idempotency-Key and stores the final response in the same transaction as the outcome (domain-model Decision 14).

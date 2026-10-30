# ADR-010: Reconciliation Finishes Every In-Flight Payment — Re-Charge with the Provider's Idempotency Key, Leased Batches

## Status

Accepted (Day 49C)

## Context

ADR-009 moved the gateway call outside every transaction and left durable traces of a payment that is under way: `PROCESSING` before the charge, `REFUND_PENDING` before the refund. On Day 49B nothing moved those traces on. A payment stayed `PROCESSING` forever when:

- the process stopped after phase 1, before calling the gateway;
- the gateway call ended without an answer (timeout, reset connection), so the provider may or may not have charged;
- the gateway charged but the process stopped before phase 3 committed.

A payment also stayed `REFUND_PENDING` forever when the refund call failed. Idempotency-Keys were never deleted.

An unknown outcome cannot be resolved by guessing. Calling it a failure lets the customer pay again while the first charge may have gone through. Calling it a success confirms seats nobody paid for. Only the provider knows, and only a definite answer from it may decide.

## Decision

A **reconciliation job** finishes every non-terminal payment (domain-model Decision 15).

1. **Definite answers come from charging again with the same payment id.** The payment id is the provider's idempotency key (ADR-009). A second `charge` returns the first one's result if it exists and charges now if it does not, so after the call there is exactly one result for that id, including for a delayed request that arrives later. The payment keeps its payment-method token for that call.
2. **The job claims due payments in a short transaction and holds no lock across the call.** `next_attempt_at` is a lease: the claim (`FOR UPDATE SKIP LOCKED`) moves it forward by the gateway timeout + 30 s and commits, then the gateway is called, then a short transaction records the result. The same column is the age gate (phase 1 sets it past the live request's own timeout) and the retry backoff.
3. **The job records results with the request's own phase-3 code**, conditional on the source state, and completes the Idempotency-Key with the final response.
4. **Refunds happen only in the job**, with bounded retries (1, 2, 4, 8 min). The fifth failure, or a failure the provider calls permanent, ends in `REFUND_FAILED`, which is reported for a person. `PROCESSING` never gets such an end: its outcome is unknown, so it is retried until it is known.
5. **Unknown outcomes are a value, not an exception.** The gateway adapter applies the timeout and returns `unknown`; the request answers `202` and stores nothing.
6. **Idempotency-Keys are deleted after 24 h, `COMPLETED` only.** Domain invariants, not the key, refuse a second charge after that.

## Consequences

**Positive**

- Every state a payment can be in has an owner: the request, the job, or (for `REFUND_FAILED` only) a person.
- A crash at any of the four stopping points ends in a correct state once the job runs. Day 49C's fault-injection tests check this with one global invariant: money taken exactly when the booking is confirmed or the payment is refunded or reported.
- Several `api` instances can run the job: the lease keeps them off each other's payments without a lock held across the network.
- The customer no longer waits for a refund inside their request.

**Trade-offs / costs**

- **The payment keeps a provider token.** It is a reference to a payment method, not card data, but it is still a value worth protecting.
- **A payment may be charged later than the customer pressed "pay".** This happens when the first request never reached the provider: the charge happens at reconciliation, up to timeout + 30 s plus one job interval later. If the hold expired meanwhile, the charge is refunded.
- **Answers can take minutes.** A customer who got `202` learns the result by retrying with the same key; there is no push and no `GET` for a payment.
- **`REFUND_FAILED` needs people and a way to reach them.** Until phase G the "alert" is an error log line and an audit row.
- **The simulated provider remembers charges in the `api` process.** A restart forgets them, so a re-charge after a restart charges again. A real provider does not forget; this is a limit of the simulator, written down and not hidden.

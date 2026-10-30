# Day 49C — Payment failures: unknown outcomes, reconciliation, key cleanup (phase D, step 6c)

> ✅ Complete (2026-10-30). Unit 494/494, integration 199/199 (on `booking_test`, with the dev `app`
> running), notifier 16/16, identity 12/12; typecheck clean; reconciliation file 10× in a row; e2e on
> docker compose (HTTP + psql + app and notifier logs, 7 scenarios); Postman Day 49C folder via
> newman 8/8, Day 49B folder still 13/13.

## What and why

Day 49B left three holes, written down in Decision 14 and ADR-009: a payment stuck `PROCESSING`
when the gateway gave no answer or the process stopped after phase 1; a `REFUND_PENDING` whose refund
failed, with nothing to retry it; Idempotency-Keys never deleted. Today a gateway call has a third
result, **unknown**, which is never read as a failure (BR-PAY-08); a reconciliation job finishes
every payment a request could not, by charging again with the same payment id; refunds moved out of
the request into that job, with bounded retries and a state for people (BR-PAY-09); a cleanup job
deletes completed keys after 24 h (BR-PAY-10).

First, the integration tests got their own database: on Day 49B they wiped dev data and the dev
app's expiry job swept test bookings, and a second job sweeping payments would only make that worse.

## Decisions made with the student

| Question | Choice |
|---|---|
| Unknown outcome: what does the customer get | `202` with the `PROCESSING` payment, not stored; the key stays `IN_PROGRESS`; the same key gives the final answer once reconciled. No `GET` for a payment |
| Reconciling `PROCESSING` | Charge again with the same payment id (not "only ask"); a lease in `next_attempt_at` keeps two instances off one payment |
| Where refunds run | Only in the job; the request commits `REFUND_PENDING` and answers `409` at once |
| Refund retries | 5 attempts, 1/2/4/8 min apart; not retryable or the fifth → `REFUND_FAILED` + error log. `PROCESSING` is never given a terminal state by the job |
| Defaults proposed and kept | Gateway timeout 10 s, **at most 20 s** (timeout + 30 s stays under BR-PAY-07's 60 s; 30 s would leave no room); reconciliation 30 s after the timeout; keys deleted when `COMPLETED` and 24 h old, never `IN_PROGRESS`; test database `booking_test` in the same container |
| Code-writing permission | Confirmed for this session, first person |

## Step 0 — A separate test database, with a guard

`BOOKING_POSTGRES_DB` (default `booking_db`) in both config parsers; `test:integration` sets
`booking_test` and preloads `tests/integration/require-test-database.ts`, which exits before any
test file runs unless the name ends in `_test`. `docker/postgres-init/02-create-booking-test-db.sh`
creates it on a fresh volume (owner `booking`, `REVOKE CONNECT FROM PUBLIC`); the existing volume got
it once by hand (README). Proven: pointed at `booking_db` or left unset, the run stops with
"Refusing to run …" and no test body runs; the full suite on `booking_test` with the dev `app`
running left every dev row count unchanged (reference data seeded first, so the comparison meant
something). A self-check test asserts `current_database()` ends in `_test`.

## Step 1 — Decision 15, Payment lifecycle, BR-PAY-08..10, ADR-010

Decision 15 (three results; timeout at the adapter; `202`; re-charge vs only asking — the Pause &
Think answer; age gate; lease; one phase 3; refunds in the job; bounded refunds; keys 24 h; actor
`system/payment-reconciliation`). Payment table: `PROCESSING → PROCESSING` (unknown),
`REFUND_PENDING → REFUND_PENDING` (retry), `REFUND_PENDING → REFUND_FAILED`; every non-terminal state
has an owner. Lock order: claim (payment rows, `SKIP LOCKED`, committed before the gateway), record a
decline, record a refund, delete keys. ADR-010; ADR-009's "not final until 49C" revised.

## Step 2 — Gateway: timeout and failure modes

Port: `ChargeResult` and `RefundResult` gain `unknown`; a failed refund says `retryable`. The
simulator cuts each call with `AbortSignal.timeout(PAYMENT_GATEWAY_TIMEOUT_MS)` and answers
`unknown`; what the "provider" did before the abort stays done. Tokens: `tok_timeout_before_charge`,
`tok_lost_response`, `tok_refund_fails_twice`, `tok_refund_fails_permanently`. The fake gateway now
keeps the provider's idempotency per payment id, a `lost-response` script and a `ledger` (what the
provider really did). Proven: a 5 s call with a 50 ms timeout returns `unknown` in ~50–100 ms.

## Step 3 — Migration, and the request meeting an unknown outcome

`AddPaymentReconciliation`: `payment_method_token` (only while `PROCESSING`, CHECK), `attempts`,
`next_attempt_at` (only while `PROCESSING`/`REFUND_PENDING`, CHECK), `REFUND_FAILED`,
`IDX_payments_due`, and (Step 4) `UQ_idempotency_keys_payment_id`; refuses with a list while a
`PROCESSING` payment exists. The request answers `processing` → `202`, logs
`payment_outcome_unknown`, and no longer refunds. `toPaymentView` picks the six public fields, so
the token never reaches a response. Constraints probed with psql on `booking_test` (four bad rows,
four named CHECK violations).

## Step 4 — Reconciliation job, one phase 3

`settle-payment.ts` is phase 3, moved out of `pay-for-booking.ts` (≈150 lines removed there) and
called by both the request and `reconcile-payments.ts`; the key is completed by `payment_id`.
`PaymentRepository.claimDue` (same CTE shape as `expireDueHolds`: `SKIP LOCKED`, lease,
`attempts + 1`) and `reschedule`. A batch's gateway calls run concurrently so the batch finishes
within one timeout, inside its lease. A payment that throws is logged and skipped. Mutations: no age
gate → the "not touched before its time" test fails; unknown → `FAILED` → the BR-PAY-08 test fails.

## Step 5 — Idempotency-Key cleanup

`deleteCompletedBefore` (status **and** age, oldest first, `SKIP LOCKED`), `CleanupIdempotencyKeys`
(24 h, batches of 500, at most 20), `idempotency-key-cleanup-job` (hourly). A key created exactly
24 h ago stays; an old `IN_PROGRESS` key stays.

## Step 6 — Fault injection and races (Postgres)

`postgres-payment-reconciliation.integration.test.ts`, every test ending on `assertMoneyInvariants`
(ledger vs database: money taken ⇔ `SUCCEEDED` + `CONFIRMED`, `REFUNDED` or `REFUND_FAILED`; each id
charged/refunded at most once; `CONFIRMED` ⇔ a `SUCCEEDED` payment; seats match bookings; keys
`COMPLETED` with the matching status). File run **10× in a row: 10/10, 12/12 each**.

| Test | Stopping point | Result |
| --- | --- | --- |
| 1 | after phase 1, before the gateway | job charges once → `CONFIRMED`, key `201` |
| 2 | timeout before the provider received it | `202`, same key `409`; job charges → `CONFIRMED`; 2 calls, 1 charge |
| 3 | charged, answer lost, hold valid | job's call returns the first charge; 1 charge; replay `201` |
| 3b | charged, answer lost, hold expired | `REFUND_PENDING` → next run `REFUNDED`; replay `409` |
| 4 | `REFUND_PENDING`, refund not made | job refunds |
| 5 | refund fails twice | `REFUNDED` on the 3rd attempt (0, +1, +3 min) |
| 6 | refund fails permanently | `REFUND_FAILED` once, error log, audit, never retried |
| Race | live request (gated in `charge`) vs the job | job confirms; the request's phase 3 rolls back (it throws); replay `201`; 1 `BOOKING_CONFIRMED`, 1 event, 0 refunds |
| Race | two job instances at once, 30 abandoned payments | 30 job calls, one per payment (A settled 20, B 10 every run) |
| Control | no lease, second instance after the first committed | **30 duplicate gateway calls**, still 1 charge and 1 settlement per payment |
| Cleanup | key deleted after 24 h, same request | `409 BOOKING_NOT_PAYABLE`, no charge, one `SUCCEEDED` |
| Plans | `EXPLAIN` with seqscan off | `IDX_payments_due`, `IDX_idempotency_keys_created_at` |

Mutation: lease removed (`least($1, $2)`) → the two-instance race fails 3/3, the request race still
passes. (A first attempt left `$2` unused and broke every claim — not a valid mutant; redone.)

## Step 7 — E2E and docs

App rebuilt with `PAYMENT_GATEWAY_TIMEOUT_MS=4000`, `PAYMENT_SIMULATOR_DELAY_MS=2000`; the new
migration ran on `booking_db` at boot (0 payments there). Identity `npm run dev`, fresh accounts.

```text
1. tok_lost_response              → 202 in 4.0 s, PROCESSING, token kept, due after 34 s, key IN_PROGRESS
2. same key at once               → 409 IDEMPOTENCY_KEY_IN_PROGRESS in 7 ms
3. after the job                  → booking CONFIRMED, payment SUCCEEDED (token null), key COMPLETED 201;
                                    same key → 201, Idempotent-Replayed: true
4. cancel during a tok_success charge   → cancel 204 in 13 ms; payment 409 in 2.0 s (Day 49B: 16 s);
                                    REFUNDED by the job
5. same with tok_refund_fails_permanently → 409; job → REFUND_FAILED, error payment_refund_needs_attention
   job log: payments_reconciled settled 1, refunded 1, refundFailed 1
6. tok_timeout_before_charge      → 202 in 4.0 s; job → CONFIRMED, key 201
7. integration suite with app running → 199/199; dev rows changed only by the app's own reconciliation
   of scenario 6 (BOOKING_CONFIRMED system/payment-reconciliation + its outbox row, 09:08:09)
   notifier: 2 × booking_confirmed_consumed
```

Docs: README (configuration, payment answers with `202`, new Day 49C section, audit rows, jobs,
migrations, flow, limitations), `docker-compose.yml` + `.env.example` pass
`PAYMENT_GATEWAY_TIMEOUT_MS`, Postman **Day 49C — Payment failures** (8 requests, newman 8/8,
inserted without reformatting) + `postman/README.md` step 18, domain-model BR-PAY-08..10 ✅ and step
6c done, ADR-005 / CLAUDE.md (test database), learnings `payments-and-idempotency-keys.md`,
Vietnamese notes.

## Incidents

None in the data. Mistakes of mine caught on the way: a Composition Root edit merged two properties
on one line (fixed in Step 4); the abandoned-payments helper reused one Idempotency-Key for 30
bookings (BR-PAY-02 answered `422`, as it should); the e2e script relied on bash word splitting under
zsh (two bookings cancelled with no payment, harmless).

The final check run was moved to the background mid-run; its unit step stalled (473 counted, killed
after 11 min, not reproduced: three runs after it were 494/494 in 4–6 s), and its integration step
then ran **at the same time** as a second integration run — 184/199 and 185/199, every failure a
`TRUNCATE` of the other run. Alone: 199/199 in 83 s. `booking_test` protects dev data, not one test
run from another: never run two integration suites at once.

## Test count reconciliation

```text
Unit (api):   459 (Day 49B)                                                       = 459  Step 0 (config test changed)
              + 5 (simulator) + 7 (config: 1 test + 5 subtests + ceiling)          = 471  Step 2
              − 1 (refund refused in the request) + 2 (pay-for-booking: unknown,
                no token kept) + 1 (HTTP 202) + 1 (payment contract: REFUND_FAILED)  = 474  Step 3
              + 3 (payment contract: claimDue ×2, reschedule) + 2 (job)
              + 10 (reconcile-payments)                                             = 489  Step 4
              + 1 (idempotency contract: cleanup) + 2 (cleanup) + 2 (job)           = 494  Step 5
Integration:  181 + 1 (test-database self-check)                                    = 182  Step 0
              + 1 (payment contract)                                                = 183  Step 3
              + 3 (payment contract)                                                = 186  Step 4
              + 1 (idempotency contract) + 12 (reconciliation file)                 = 199  Steps 5–6
Notifier: 16.   Identity: 12.
```

## Not today

- Identity's integration tests still `TRUNCATE` `users` in `identity_db` (the same problem
  `booking_test` solved for api).
- `REFUND_FAILED` has no endpoint and no alert beyond a log line and an audit row (phase G).
- The simulated provider's memory is in the api process: a restart forgets charges.
- A request that outlives timeout + 30 s while the job settles its payment answers `500` (correct
  state, the key has the answer).
- Carried: the outbox relay is not multi-instance safe and consumers do not dedupe by `eventId`;
  `booking-cancelled` has no consumer; the release `ORDER BY` survivor; no fare-change endpoint;
  deprecated `priceInCents`; removing the `booking-created` contract.

## DAY 49C SUMMARY

A payment can now fail in the hard ways and still end right. The gateway adapter cuts a call at a
timeout and says "unknown" instead of guessing; the request answers `202` and keeps the payment
`PROCESSING`. A reconciliation job, which never calls the gateway inside a transaction, leases due
payments, charges them again with the same payment id — the provider's idempotency key, so a lost
answer comes back instead of a second charge — and settles them with the request's own phase 3.
Refunds left the request for that job, with 1/2/4/8-minute retries and `REFUND_FAILED` for a person.
Keys are deleted after 24 h, and the confirmed booking, not the key, refuses a late repeat.
Integration tests run on `booking_test` behind a guard. Fault injection at each stopping point ended
on one money invariant; without the lease, two instances made 30 duplicate gateway calls, with it 0.

**Suggested commit message:**

```text
feat(api): payment reconciliation — unknown gateway outcomes answered 202 and finished by a job that charges the same payment id again, refunds moved out of the request with bounded retries, Idempotency-Key cleanup after 24 h, and a separate guarded test database - gateway adapter timeout (PAYMENT_GATEWAY_TIMEOUT_MS, AbortSignal) returns unknown, never FAILED (BR-PAY-08); simulator failure tokens; AddPaymentReconciliation (token only while PROCESSING, attempts, next_attempt_at as age gate + lease + backoff, REFUND_FAILED, IDX_payments_due, UQ_idempotency_keys_payment_id); SettlePayment shared by request and job; payment-reconciliation-job (SKIP LOCKED, lease, concurrent gateway calls per batch), refunds 1/2/4/8 min then REFUND_FAILED + error log (BR-PAY-09); idempotency-key-cleanup-job (COMPLETED and 24 h old, BR-PAY-10); integration tests on booking_test behind a preloaded _test guard; Decision 15, ADR-010; fault injection at four stopping points with a global money invariant, request-vs-job and two-instance races with a no-lease control (30 duplicate calls vs 0), e2e, Postman Day 49C
```

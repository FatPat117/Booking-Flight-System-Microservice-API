# Day 49B — Simulated payment with an Idempotency-Key, `HELD → CONFIRMED` (phase D, step 6b)

> ✅ Complete (2026-10-26). Unit 459/459, integration 181/181, notifier 16/16, identity 12/12;
> typecheck clean; payment race file 10× in a row; e2e on docker compose (HTTP + psql + app and
> notifier logs + queues, 6 scenarios); Postman Day 49B folder via newman, 13/13.

## What and why

A `HELD` booking could never become `CONFIRMED`, so every booking expired after 15 minutes.
Today: US-PAY-01 and BR-PAY-01..07. A simulated gateway charges `booking.total` (fixed at hold time
since Day 49A); the call runs **outside any database transaction**, in three phases with a refund
when the booking is lost meanwhile (ADR-009); an `Idempotency-Key` makes a repeated request safe.
Two Day 43 texts were revised, not ignored: the Payment lifecycle gains `PROCESSING` (the call
outside the transaction makes "started, not finished" real), and the payment-vs-expiry race note no
longer says "create the payment after the booking update".

## Decisions made with the student

| Question | Choice |
|---|---|
| Payment vs expiry/cancel | (a) always refund when phase 3 loses + (b) start only with more than **60 s** left (BR-PAY-07). Confirmation decided at phase 3's own `now`, BR-BOOK-10 `> now` unchanged. (c) freezing expiry while `PROCESSING`: not done (couples the 48B sweep to payments; without 49C a crash would hold seats forever) |
| Request body | Carries `amount`; the server compares it with `booking.total` → `422 PAYMENT_AMOUNT_MISMATCH` |
| Migration refused on dev data (VN29/VN888 lacked BUSINESS fares) | Set the BUSINESS fares by hand with psql, then ran migrations |
| Code-writing permission | Confirmed for this session, first person |

## Step 0 — Lock order table

`docs/product/domain-model.md`: the table gained a "Then" column; the hold rows show the fare share
lock (Day 49A); new row **Confirm payment (phase 3)**: booking row → its seats `(row, letter)` →
payment row → idempotency row. Phase 1 only inserts (FK `KEY SHARE` on the booking does not conflict
with an `UPDATE` of `status`). Cancel and expiry never touch `payments`/`idempotency_keys`.

## Step 1 — Decision 14, Payment lifecycle, BR-PAY-07, ADR-009

Decision 14 (three phases; Day 43 revised; states `PROCESSING/SUCCEEDED/FAILED/REFUND_PENDING/
REFUNDED`; race strategy; record the refund before making it; amount captured once; Idempotency-Key
rules, what is and is not replayed; two keys one booking; unknown gateway error keeps the key; HTTP;
audit/events). New Payment lifecycle table. ADR-009 "External calls stay outside database
transactions" (Nygard format) + index row.

## Step 2 — Migrations (after the dev data refusal above)

- `1790512000000-CreatePayments`: `amount_vnd bigint` ≤ 2^53 − 1, 5-state CHECK, money taken ⇒
  `provider_reference`, `FAILED` ⇒ `failure_reason`; partial unique `(booking_id) WHERE status =
  'SUCCEEDED'` (BR-PAY-05) and `… = 'PROCESSING'` (arbiter for `ON CONFLICT … WHERE`).
- `1790515600000-CreateIdempotencyKeys`: PK `(account_id, operation, key)`, fingerprint,
  `IN_PROGRESS/COMPLETED`, `response_status` + `response_body`, `payment_id` FK; CHECK `COMPLETED ⇔
  response present`; index `created_at` (cleanup in 49C).
- Probed: `ON CONFLICT ("booking_id") WHERE "status" = 'PROCESSING' DO NOTHING` → `INSERT 0 0`, no
  `23505`. `down` + `up` ran.

## Step 3 — Gateway port, simulator, fake

`PaymentGateway` (`charge` → `succeeded(providerReference) | declined(reason)`; `refund` →
`refunded | failed(reason)`; `paymentId` is the provider-side idempotency key).
`createSimulatedPaymentGateway({ delayMs })`: `tok_success` / `tok_decline` / other →
`unknown_payment_method`; same `paymentId` → same result. `PAYMENT_SIMULATOR_DELAY_MS` (optional,
0–60 000). `createFakePaymentGateway({ onCharge })` with scripted results and recorded calls.
Deviation: wiring moved to Step 5, where the use case that needs it exists.

## Step 4 — Idempotency components

`requestFingerprint` (SHA-256 of canonical JSON: keys sorted, array order kept). Port
`IdempotencyRepository` (`claim`, `attachPayment`, `complete`, `release`), Postgres adapter (claim =
`INSERT … ON CONFLICT DO NOTHING` then read; a concurrent claim waits for the first transaction),
in-memory fake, contract run on both tiers + 2 Postgres-only concurrency tests (commit → in-progress,
rollback → claimed).

## Step 5 — `PaymentRepository`, `confirmHold`, the use case

- `PaymentRepository` (`start` → `started | payment-in-progress`; `markSucceeded/Failed/
  RefundPending/Refunded`, each conditional on its source state, throwing on a mismatch; `findById` —
  not in the plan, for tests and 49C), Postgres adapter, fake mirroring both partial indexes, contract
  (7) + 2 Postgres concurrency tests.
- `BookingRepository.confirmHold(bookingId, scope, now)`: one statement — `UPDATE bookings … WHERE
  status = 'HELD' AND hold_expires_at > $now` + owner condition, then seats `HELD → BOOKED`.
  `releaseSeatsOf` was generalised to `updateSeatsOf(source, assignments)` so confirm locks seats in
  the same `(flight_id, row, letter)` order as cancel and expiry. Contract + 4 cases.
- `createPayForBooking`: phases as in Decision 14. `payment-response.ts` maps final outcomes to the
  stored `{ status, body }` — the one module outside `app.ts` that knows HTTP codes, because the
  response must be written inside phase 3's transaction. A failed refund is logged
  (`payment_refund_failed`), not thrown: the customer's answer is already stored.
- Audit: `BOOKING_CONFIRMED`, `PAYMENT_FAILED`, `PAYMENT_REFUND_PENDING`, `PAYMENT_REFUNDED`; target
  `payment`; actor `system/payment-refund`. No migration (CHECKs only require a non-empty value).
- `booking-confirmed` contract (all fields required: no older messages) + notifier consumer.

## Step 6 — Route

`POST /api/bookings/:id/payments`, `requireJwt` + `requireRole("user")` (admin 403). The route checks
the `Idempotency-Key` header (missing → `422 IDEMPOTENCY_KEY_REQUIRED`, malformed → `422
VALIDATION_FAILED`) and the body (`validatePaymentInput`) **before** the key is claimed, and builds the
fingerprint from `POST`, the path rebuilt from `:id` and the validated body. Stored answers are sent
as stored, with `Idempotent-Replayed: true` on a replay. No `Location`, no GET.

## Step 7 — Race tests, e2e, docs

**`api/tests/integration/postgres-payment-race.integration.test.ts`** (real use cases, separate pool
connections, fake gateway with `onCharge` gates). File run **10× in a row: 10/10, 6/6 each**:

| Test | Scenario | Result |
| --- | --- | --- |
| A | 10 requests, one key, charge 200 ms | 1 charge; 1×`201`, 9×`409 IDEMPOTENCY_KEY_IN_PROGRESS` every run; key `COMPLETED` and linked |
| B | 5 keys, one booking, 10 rounds | exactly 1 `SUCCEEDED` per round; `201 ×10, payment-in-progress ×40`; charges = succeeded + refunds |
| C | gate in `charge`; expiry job runs meanwhile | job not blocked, booking `EXPIRED`, payment `REFUNDED`, no `booking-confirmed` |
| D | gate in `charge`; owner cancels meanwhile | cancel took 2–4 ms; `CANCELLED` + `REFUNDED` |
| C (deadline) | phase 3 at deadline − 1 ms and the sweep at the deadline, together, 20 rounds | 17–19 confirmed / 1–3 expired and refunded; one end per booking |
| E (control) | gateway inside one transaction (`SELECT … FOR UPDATE`, 1 s) | cancel waited **908–922 ms**; the job **skipped** the locked booking (0 expired); three phases: cancel **2–11 ms** |

Invariant after every test: seat `HELD` ⇔ booking `HELD`, `BOOKED` ⇔ `CONFIRMED`, no ended booking
owns a seat. Found while writing B: rounds reused key strings with a path-less fingerprint, so a
later round replayed an earlier booking's `201` — the real route includes the path.

**E2E found a real bug: `jsonb` reorders keys.** Scenario 2 compared the replayed body byte for byte
and it differed (`details` before `message`). The contract test used `deepEqual`, blind to key
order. Fixed before commit: `response_body json` in the (uncommitted) migration, `$5::json` in the
adapter, the contract test compares `JSON.stringify` (first shown failing on Postgres, passing on
the fake). The local table was dropped and its migration re-run.

**E2E** (docker compose app + notifier rebuilt, identity `npm run dev`, seed, fresh accounts):

```text
1. success                 → 201 SUCCEEDED 3000000, booking CONFIRMED; seats 1A,1B BOOKED; 1 payment row
2. replay (same key/body)  → 201 + Idempotent-Replayed: true, body identical byte for byte; still 1 row
3. same key, other body    → 422 IDEMPOTENCY_KEY_REUSED
4. tok_decline             → 402 PAYMENT_DECLINED, booking HELD; new key → 201; payments FAILED card_declined, SUCCEEDED
   amount 1500000          → 422 PAYMENT_AMOUNT_MISMATCH "…: 3000000 VND";  no key → 422 IDEMPOTENCY_KEY_REQUIRED
5. PAYMENT_SIMULATOR_DELAY_MS=8000; at t+2s psql back-dates hold_expires_at
                           → payment PROCESSING at t+2s; DELETE → 409 BOOKING_EXPIRED in 42 ms (not blocked)
                           → answer after 16 s (8 s charge + 8 s refund): 409 BOOKING_NOT_PAYABLE (refunded)
                           → payment REFUNDED; audit BOOKING_CREATED, PAYMENT_REFUND_PENDING (account),
                             PAYMENT_REFUNDED (system/payment-refund); key COMPLETED 409;
                             the job then expired the booking, seats released
6. notifier                → 4 × booking_confirmed_consumed (reference, passengerCount 2, paymentId, 3000000 VND);
                             outbox payload payment + total; every DLQ 0 (booking-cancelled: 8, no consumer by design)
```

Docs: README (configuration, auth table, Day 49B section with the answer table, audit rows,
messaging, limitations), `docker-compose.yml` + `.env.example` pass `PAYMENT_SIMULATOR_DELAY_MS`,
Postman **Day 49B — Payment** folder (13 requests, newman 13/13; inserted without reformatting the
file) + `postman/README.md` steps 16–17 (Day 49A had been missing), domain-model BR-PAY-01..07 ✅ and
step 6b done, learnings `payments-and-idempotency-keys.md`, Vietnamese notes
(`on-tap-nhanh-day-01-49a.md` → `-49b.md` via `git mv`, `race-conditions/10-…`, interview Q&A ×4,
use cases, migrations 25–26, README). BR-PAY-06 got its own unit test before being marked ✅.

## Incidents

- **`npm run test:integration` wiped the dev data.** In Step 4 the full integration suite ran against
  `booking_db`, where it `TRUNCATE`s the tables — the VN29/VN888 flights and bookings kept on purpose
  were lost (no backup). An orphaned runner from the same command then caused 36 spurious failures on
  the next run; a clean run was 162/162.
- **The dev `app` container sweeps test data.** With `app` running after the e2e, the final full
  suite failed Test B once (0 `SUCCEEDED`): the container's expiry job, on the real clock, expired a
  test booking held at 2026-07-20 in the middle of a round (`booking_holds_expired expired 1` at
  09:48:44Z). With `app` stopped: 181/181. Same root cause as the first incident.

## Test count reconciliation

```text
Unit (api):   400 (Day 49A) + 7 (simulator) + 5 (config: 1 test + 4 subtests)          = 412  Step 3
              + 8 (idempotency contract, fake) + 5 (fingerprint)                        = 425  Step 4
              + 4 (booking contract: confirmHold) + 7 (payment contract, fake)
              + 14 (pay-for-booking)                                                    = 450  Step 5
              + 8 (bookings API: payment route)                                         = 458  Step 6
              + 1 (pay-for-booking: BR-PAY-06)                                          = 459  Step 7
Integration:  152 + 8 (idempotency contract) + 2 (claim concurrency)                    = 162  Step 4
              + 4 (booking contract) + 7 (payment contract) + 2 (start concurrency)     = 175  Step 5
              + 6 (payment race: A, B, C, D, C deadline, E)                             = 181  Step 7
Notifier:     14 + 2 (booking-confirmed consumer) = 16.   Identity: 12.
```

The idempotency contract case "keeps its JSON body exactly" was strengthened, not added.

## Not today

- **Payment failures** (49C): a `PROCESSING` payment whose gateway call failed or whose process
  crashed, a `REFUND_PENDING` whose refund failed, Idempotency-Key cleanup after 24 h.
- **A separate test database.** Integration tests share `booking_db` with dev: running them wipes dev
  data, and a running `app` (expiry job) can break them. Both happened today.
- The refund runs inside the paying request (a slow refund delays the `409`); a queue later.
- `booking-cancelled` still has no consumer; no `GET` for a payment (no story).
- Carried: no fare-change endpoint, deprecated `priceInCents`, removing the `booking-created`
  contract, the release `ORDER BY` survivor, the outbox relay not being multi-instance safe.

## DAY 49B SUMMARY

A held booking can now be paid. The gateway is called between two short transactions, never inside
one: measured with a 1 s charge, a transaction around it made a cancel wait ~0.9 s and the expiry
job skip the booking; three phases kept the cancel at 2–11 ms. Phase 3 confirms with the same
`hold_expires_at > now` condition as cancel, so expiry and cancel need no knowledge of payments; when
it loses, the payment is recorded `REFUND_PENDING`, committed, then refunded. An Idempotency-Key —
claimed with `ON CONFLICT DO NOTHING`, fingerprinted, its answer stored in the outcome's own
transaction — turned 10 identical requests into one charge, and partial unique indexes stop two
different keys. The e2e caught what the contract test could not: `jsonb` reorders keys, so stored
responses are `json`.

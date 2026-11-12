# Day 52 — Flight cancellation cascade (phase D, step 9)

> ✅ Complete (2026-11-12). Unit 614/614, integration 292/292 (on `booking_test`), notifier 20/20,
> identity 12/12 + integration 7/7 (not touched); typecheck clean; race matrix A–G 10 runs in a row
> green; e2e on docker compose (6 scenarios); Postman Day 52 folder via newman 15/15 requests,
> 18/18 assertions.

## What and why

An admin could not cancel a flight: the lifecycle allowed `→ CANCELLED` since Day 46, but no route
offered it, because cancelling the flight alone would leave live bookings on it (US-OPS-01,
BR-FLT-07). The cascade touches every booking state built in phase D (holds, payments, refunds,
seat changes), so it came last. It was also where the Day 47 review's deadlock hypothesis could be
tested: the hold locks seats then shares the flight, so a cancellation that locks the flight then its
seats closes a cycle. The day's question was how many transactions a cancellation of hundreds of
writes should be, answered with a controlled experiment and per-transaction lock times.

## Decisions made with the student

| Question | Choice |
|---|---|
| One transaction (A) or a status change plus a cascade (B) | **B** (Decision 18, ADR-011) |
| Payment phase 3 when the flight is cancelled | **Loses**: the confirm shares the flight row and requires it not `CANCELLED` |
| `flight-cancelled` event | **No**: each booking has its own `booking-cancelled`; the audit records the flight |
| Scope for the system job | Reuse `{ kind: "admin" }` (which rows); the actor `system/flight-cancellation` says who |
| git commit | None; a suggested message at the end of this file |
| Rebuild, migration and e2e data on `booking_db`, newman | Allowed |
| Defaults proposed and kept | Cancellable from `SCHEDULED`/`OPEN`/`CLOSED`; valid `HELD` cancelled at once, lapsed left to expiry; `cancellation_reason` `CUSTOMER`/`AIRLINE` backfilled `CUSTOMER`; event `reason` optional; progress derived (`remainingBookings`); second cancel `200`; seats back to `AVAILABLE` |

## Step 0 — Three items left from Day 51

- "A `HELD` booking's seats never change" is written at both ends: next to BR-BOOK-07 in
  `domain-model.md` ("Depended on"), and next to `confirmHold` / `expireDueHolds`, naming BR-BOOK-07.
- "Sealed" became "bound to the query": `seal` → `bindToQuery` in `search-cursor.ts`, BR-FLT-11
  rewritten, with why no HMAC is needed (every field is public and client-chosen).
- The "under 10 ms" now carries its conditions: one client, sequential runs, median of 7 with a warm
  cache, `EXPLAIN ANALYZE` execution time, no concurrent load (DAY-51 and the search learnings note).

## Step 1 — Decision 18

Written in `domain-model.md` with the Flight, FlightSeat and Booking lifecycle tables, the lock-order
table (rows "Cancel a flight", "Flight cancellation cascade (job)", confirm with the flight share
lock first) and a note on why option B cannot form the Day 47 cycle. US-OPS-01 in `scope.md` was
rewritten: the reason is `AIRLINE` (not `FLIGHT_CANCELLED`), and the cascade runs after the response.
Two contradictions in the old tables were fixed: a `CONFIRMED` booking's seats went `UNAVAILABLE` but
a `HELD` one's `AVAILABLE`; now both `AVAILABLE` (`UNAVAILABLE` stays unused).

## Step 2 — The cancel command

`cancel-flight.ts` (the `open-flight` shape) and `POST /api/flights/:id/cancel`: a compare-and-set of
the stored status plus `FLIGHT_CANCELLED` (metadata: the **effective** previous status, so `CLOSED`
is visible), nothing else. Already cancelled, or losing the compare-and-set to another cancel, is
`already-cancelled` → `200`; losing to an open is `409 FLIGHT_STATUS_CHANGED`. `remainingBookings`
comes from `BookingRepository.countLiveOnFlight` (new port method, contract on both tiers).

Integration (`postgres-flight-cancellation.integration.test.ts`): a hold holding the flight's share
lock makes the cancel wait (the hold's booking is then the cascade's); a cancel holding the row makes
a chosen and an auto hold wait, then both answer `sales-closed`; one audit row only.

## Step 3 — The reason, the cancel core, the cascade job

- Migration `AddBookingCancellationReason`: column, backfill `CUSTOMER`, CHECK values, CHECK set
  exactly when `CANCELLED`. One migration (the api is one instance migrating at startup); a rolling
  deploy would need the second CHECK later.
- `BookingRepository.cancel(…, reason)`: `cancellableSql(reason)` is the condition of both the
  pre-lock and the cancel statement. `CUSTOMER` keeps the 24 h window; `AIRLINE` drops it and needs
  the flight `CANCELLED`; both need a valid hold for `HELD`. An `AIRLINE` cancel on a flight that is
  not cancelled throws (`classifyNotCancelled`).
- `createCancelBookingInTransaction`: the one cancel core (booking + seats, payment to
  `REFUND_PENDING`, audit with `reason`, event with `reason`). The owner's use case is now a thin
  wrapper passing `CUSTOMER`.
- `claimLiveBookingOfCancelledFlight` (`FOR UPDATE OF booking SKIP LOCKED`, from the cancelled flights
  through `idx_bookings_flight_id`, must run in a transaction) and `cascade-flight-cancellations.ts`:
  one booking per transaction, up to 500 per run, `now` read once per run; a claimed booking the core
  does not cancel throws. `flight-cancellation-cascade-job` every 30 s.
- Contract `booking-cancelled`: optional `reason`, absent read as `CUSTOMER`, unknown value rejected;
  the notifier logs it.

## Step 4 — Confirm loses to a cancelled flight

`confirmHold` gained a `flight` CTE, `FOR SHARE`, `status <> 'CANCELLED'`, joined by the `UPDATE`. A
confirm queued behind the cancel's uncommitted `UPDATE` re-reads the row after commit and matches
nothing; payment phase 3 then takes the existing refund branch. `CLOSED` still confirms (BR-PAY-06).
Race tests B1–B3 (cascade run / not run / confirm queued) end with no confirmation and net zero at the
provider; B' (control) shows the Day 49B statement confirming on a cancelled flight. **Mutation**:
without the condition, B2 and B3 fail (B1 passes, its booking is already cancelled).

## Step 5 — Invariants, race matrix, measurements

New global invariants (each shown failing on broken data): an `AIRLINE` cancellation is on a
`CANCELLED` flight; no `BOOKING_CONFIRMED` after the flight's `FLIGHT_CANCELLED` (by `occurred_at`, so
the race file's clock moves 1 ms per read). `assertCascadeComplete` (no live booking on a cancelled
flight) is a separate helper: it is expected to fail before the job runs.

| # | Scenario | Observed |
|---|---|---|
| A | Cancel among 20 concurrent holds, 5 rounds | 0 deadlocks, nothing thrown; **no hold was ever refused** |
| A (queue) | Hold 1 holds the share lock, cancel waits, hold 2 arrives | Hold 2 is granted the share lock at once, **ahead of the queued cancel** |
| A' (control) | Option A, test-only, forced against a chosen-seat hold | **`40P01` in 3 of 3 rounds** |
| A (forced) | The real cancel, same interleaving | 0 deadlocks; the hold queues, then `sales-closed` |
| B1–B4, B' | Payment at the gateway when the flight is cancelled | Never confirmed after the cancel; B4 (confirm first) confirmed before, then cancelled and refunded |
| C1 / C2 / C3 | Owner and cascade on one booking | Cascade skips the owner's lock / owner waits, `already-cancelled` / unforced: owner won 10/10 |
| D1 / D2 | Seat change and cascade | The new seat is released / the queued change answers `not-changeable` |
| E | Two cascade instances, 100 bookings (20 paid) | Each cancelled once; 100 audit, 100 events, 20 refunds |
| F | Job stops after 4 of 10 | Next run cancels 6, none twice |
| G | Two admins cancel at once | `cancelled` + `already-cancelled`, one audit row |

The file ran 10 times in a row, 16/16 then 17/17 each (A (queue) was added after the first 10).

The hypothesis held: flight then seats against seats then flight deadlocks. The unforced A never
refused a hold because a `FOR SHARE` request compatible with the share lock already held is granted
even while an `UPDATE` waits; the cancel runs once no hold holds the flight. Bounded by a hold's
milliseconds, written as a limitation.

### Measured (`postgres-flight-cancellation-measure`, 100 paid bookings, 120-seat flight, 3 runs)

| | Option B | Option A (test-only) |
|---|---|---|
| Transaction holding the flight row | 3.2 / 3.9 / 8.2 ms | 598.8 / 601.2 / 535.6 ms |
| Cascade transactions (101 incl. the empty claim) | median 5.0 / 9.3 / 6.0 ms, max 20 / 151 / 41 ms | — |
| Whole run | 0.60 / 1.23 / 0.79 s | 0.60 / 0.60 / 0.54 s |
| Hold on the same flight, meanwhile | `sales-closed` in 21 / 19 / 55 ms | `sales-closed` in 598 / 600 / 535 ms |
| Hold on another flight, meanwhile | `created` in 28 / 26 / 85 ms | `created` in 7 / 7 / 6 ms |

B does not finish sooner; it keeps every lock short. The other-flight hold was slower under B: the
two flights share no row, so this is not lock waiting; likely contention with 101 concurrent short
transactions on one laptop (not measured further).

## Step 6 — E2E and docs

App and notifier rebuilt; `AddBookingCancellationReason` ran on `booking_db` at startup (6 cancelled
bookings → `CUSTOMER`). Tokens signed with the shared `JWT_SECRET`. VN521 SGN→HAN on VN-A588 (180
seats), 15 February 2027.

```text
1. bookings 3TDJ7N 10A HELD, XUQ76N 10B + 7ADCH6 10C CONFIRMED (paid 201); search finds VN521
2. cancel → 200 in 34 ms, CANCELLED, remainingBookings 3; GET → CANCELLED; search no longer finds it;
   again → 200 (3); as a user → 403
3. after 8 s: all three CANCELLED / AIRLINE (log flight_cancellation_cascaded 3, refundsStarted 2);
   seat map 0 HELD/BOOKED; cancel again → remainingBookings 0
4. ~18 s later: both payments REFUNDED (payments_reconciled refunded 2); audit FLIGHT_CANCELLED 1,
   BOOKING_CANCELLED 3 and PAYMENT_REFUND_PENDING 2 by system/flight-cancellation, PAYMENT_REFUNDED 2
5. flight-notifier: three booking_cancelled_consumed with reason AIRLINE (refund 1 500 000 ×2, null);
   every *.dlq at 0, no rejection logged
6. hold on the cancelled flight → 409 SALES_CLOSED
```

Postman **Day 52 — Flight cancellation cascade** (15 requests, newman 15/15, 18 assertions; one 32 s
wait for the job), inserted as text (442-line diff, no reformatting). A second run failed at once with
`409 FLIGHT_ALREADY_EXISTS`: flight number + departure stays unique for a cancelled flight. The folder
description said it could run again; corrected, and `postman/README.md` step 21 gives the cleanup SQL
(dry-run in a rolled-back transaction on `booking_db`).

Docs: README (new Day 52 section, audit rows, job table, messaging, migration, limitations),
`postman/README.md` step 21, domain-model (Decision 18 tested/measured, BR-FLT-07 ✅, step 9 done, a
status note on step 10), ADR-011 (new) + index, learnings `flight-cancellation-cascade.md` (new) +
index, Vietnamese notes (on-tap renamed to `-52`, race-conditions 14, interview concurrency Q20–21 and
architecture Q12, use-cases flights + bookings + jobs + index, migration 29, "Cập nhật đến Day 52";
links checked across 70 files, none broken).

**Data left in `booking_db`:** VN521 (15 Feb 2027) and VN522 (16 Feb 2027), both `CANCELLED` with
their cancelled bookings; to rerun the Postman folder, delete VN522 first (step 21).

## Incidents

- The Day 52 brief arrived labelled "Day 53" in the chat; it was Day 52's content and was planned as
  Day 52.
- The dev stack's Postgres and RabbitMQ were stopped (5 days); started with permission, no rebuild.
- One background unit run hung at `bookings.api.test.ts`; alone it passed in 1 s and the full suite
  in 6 s afterwards. Not reproduced, cause unknown.
- My mistakes, caught by tests: a departed flight created through a helper asserting `SCHEDULED`; a
  second fixture flight on the same aircraft and time (BR-FLT-08); an `UPDATE … RETURNING` read as
  rows (TypeORM returns `[rows, count]`); option A's hold started inside its transaction's callback
  (`NestedTransactionError`, it inherited the context); F assumed claim order (it is by UUID); D2
  expected `sales-closed`, but the booking's state is checked first (`not-changeable`).
- The unforced A passed 50 rounds without ever reaching the side it was meant to test; found by
  counting outcomes, then covered by a forced test.
- `git mv` was used for the on-tap rename, so that rename is staged in the index (nothing committed).

## Test count reconciliation

```text
Unit:        580 − 0 + 34 = 614
  Step 2  +18  cancel-flight 12, flights.api cancel 5, countLiveOnFlight contract (fake) 1
  Step 3  +14  cascade use case 7, cascade job 2, reason/claim contract (fake) 5
  Step 4   +2  pay-for-booking (flight cancelled at the gateway) 1, confirm contract (fake) 1
Integration: 260 − 0 + 32 = 292
  Step 2   +4  flight-cancellation 3, countLiveOnFlight contract (postgres) 1
  Step 3   +5  reason/claim contract (postgres)
  Step 4   +5  race B1–B3 + B' 4, confirm contract (postgres) 1
  Step 5  +18  invariants 3, race matrix 13 (file 4 → 17), measurements 2
Notifier:    19 − 0 + 1 = 20   (reason AIRLINE logged; two invalid reasons added to the reject list)
Identity:    12 + 7, unchanged
```

## Not today

- Phase D step 10 (admin reports, read-only) is still in the domain-model order; the brief treated
  step 9 as the end of phase D. Day 53 decides.
- Payment phase 1 does not check the flight: a payment started before the cascade reaches its booking
  is charged, then refunded.
- A cancel can be delayed by a stream of holds (share locks granted ahead of it); no timeout.
- The claim reads the bookings of every cancelled flight each run; a partial index on live bookings is
  the lever if cancelled flights pile up.
- A flight number cannot be reused at the same departure after cancelling.
- No `flight-cancelled` event, no customer-facing "your flight was cancelled" beyond the per-booking
  event; no endpoint showing a refund finished (carried).
- Carried: `REFUND_FAILED` has no endpoint or alert; the simulator's provider memory is in-process; the
  outbox relay is not multi-instance safe and consumers do not dedupe by `eventId`; no fare-change
  endpoint; deprecated `priceInCents`; removing the `booking-created` contract; the release
  `ORDER BY` survivor; search has no fare-class filter; the free-seats partial index.
- The full Postman collection was not re-run: older folders need VN511–514 deleted (Day 51) and
  VN522 (Day 52), and were not re-checked after the Day 51 `fareClass` change.

## DAY 52 SUMMARY

An admin can now cancel a flight, and every booking on it ends: the request changes only the flight —
a few milliseconds, one row — and a job driven by the database's own state cancels each live booking
in a short transaction of its own, through the same cancel core a customer uses, with the reason as
data that decides the 24-hour rule. A payment that was at the gateway when the flight was cancelled
can no longer confirm: the confirm reads the flight under a share lock and is refunded. The Day 47
hypothesis was tested rather than argued: the one-transaction design deadlocked against a chosen-seat
hold in every forced round, the chosen design never did, and on 100 paid bookings it held the flight
for 3–8 ms instead of 0.6 s. The unforced race found something the hypothesis had not predicted —
holds overtaking a waiting cancel — and it is written down as observed.

**Suggested commit message:**

```text
feat(api): flight cancellation cascade — the admin's cancel changes only the flight, a state-driven job cancels each live booking with reason AIRLINE through the shared cancel core, and payment confirmation loses to a cancelled flight - POST /api/flights/:id/cancel (admin): compare-and-set to CANCELLED from SCHEDULED/OPEN/CLOSED + FLIGHT_CANCELLED audit, nothing else; already cancelled → 200 again; remainingBookings derived (countLiveOnFlight); flight-cancellation-cascade-job (30 s, ≤ 500/run): claim one live booking of a CANCELLED flight FOR UPDATE SKIP LOCKED, cancel core with reason AIRLINE (no 24 h window, needs the flight CANCELLED), one booking per transaction, SUCCEEDED → REFUND_PENDING, no gateway call; createCancelBookingInTransaction shared with the owner's cancel (CUSTOMER); bookings.cancellation_reason via AddBookingCancellationReason (backfill CUSTOMER, CHECK set exactly when CANCELLED); booking-cancelled gains an optional reason (absent = CUSTOMER), notifier logs it, no flight-cancelled event; confirmHold shares the flight row and requires it not CANCELLED (B' control, mutation); Decision 18, ADR-011, BR-FLT-07; global invariants for the reason and the confirm/cancel order, race matrix A–G 10 runs with the option-A control (3/3 40P01 vs 0), measured lock times (3–8 ms vs 536–601 ms); Day 51 items: HELD-seats dependency at both ends, cursor "bound to the query", measurement conditions; e2e, Postman Day 52

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

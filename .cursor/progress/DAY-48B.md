# Day 48B — Hold expiry job, expiry vs cancel race (phase D, step 5 part 2)

> ✅ Complete (2026-10-17). Unit 377/377, integration 140/140, notifier 10/10, identity 12/12;
> typecheck clean; expiry race file 10× in a row; e2e on docker compose (HTTP + psql + app and
> notifier logs); Postman both Day 48B folders + Day 48A via newman, 0 failures.

## What and why

Day 48A created `HELD` bookings with a 15-minute deadline that nothing enforced: a seat stayed
`HELD` until its booking was cancelled. Today closes US-SEAT-02 / BR-BOOK-04 with a hybrid
(Decision 12): a batched `SKIP LOCKED` job frees the inventory, reads derive `EXPIRED`, and
decisions (cancel now, payment in step 6) check the deadline inside their own `UPDATE`, on the
complementary side of one boundary (BR-BOOK-10: `<= now` expired, `> now` valid). Planning the
lock order of hold / cancel / expiry found a real deadlock between an unordered release and a
chosen-seat hold; it was reproduced deterministically and fixed with one shared ordered-lock CTE.

## Decisions made with the student

| Question | Choice |
|---|---|
| Cancel of an overdue hold the job has not swept | Expired wins: `409 BOOKING_EXPIRED`, nothing written; an already `EXPIRED` booking gets the same |
| Event | `booking-expired` through the outbox, contract + notifier consumer |
| Hold duration configurable? | No — `HOLD_DURATION_MS` stays; e2e back-dates with psql |
| Job cadence | 60 s, batch 50, at most 20 batches per run |
| Release lock-order risk | Measure first (race test E), then fix with an ordered lock CTE shared by cancel and expiry |

## Step 0 — Day 48A leftovers closed

1. **`ORDER BY` in the chosen-seat lock.** The function doc comment already explained the
   global lock order and the surviving mutation; a short SQL comment now sits on the line
   itself (`holdChosenSeats` in `postgres-booking-repository.ts`), because the line is what a
   future refactor would delete and no test would notice.
2. **`SKIP LOCKED` edge for system-picked multi-seat holds: accepted.** Two holds racing for
   the last seats can both answer `NOT_ENOUGH_SEATS`. A second waiting pass in lock order was
   rejected (slower path, queues on the busiest flights) because the edge was measured 0/200,
   the refusal writes nothing and a retry succeeds. Written as a bullet of Decision 11 in
   `docs/product/domain-model.md`, pointing at the README limitation and the ADR-004 addendum.

## Step 1 — Decisions written before code (`docs/product/domain-model.md`)

- **Decision 12 — hold expiry.** Hybrid: the job frees inventory (deriving "free" on read
  would cost the Day 47 partial-index count and make holds steal expired seats); reads derive
  `EXPIRED`; decisions put the deadline in their own `WHERE`. Overdue cancel → `409
  BOOKING_EXPIRED`, nothing written. Event `booking-expired` + consumer. Job 60 s / batch 50 /
  max 20 batches, one transaction per batch, `SKIP LOCKED` for several instances; the seat map
  shows `HELD` for up to ~60 s after the deadline (accepted). Failing batch retried whole
  (head-of-line, like Day 24). `HOLD_DURATION_MS` stays a constant. Audit actor
  `system/booking-hold-expiry`, no migration.
- **BR-BOOK-10 — the time boundary.** At `t`: expired when `holdExpiresAt ≤ t`, valid when
  `> t`. Expiry takes `≤`, cancel and payment take `>`; no instant on both sides or neither.
  BR-BOOK-06 and the BR-PAY-06 note now say a `HELD` cancel is limited by the hold itself.
- **Lifecycles.** Booking: `HELD → CANCELLED` by the owner split from the flight-cancellation
  row and given the `> now` condition; `HELD → EXPIRED` names the system actor; "stored vs
  shown" note. FlightSeat: expiry releases too, in lock order. New race note: cancel vs expiry.
- **Lock-order table** for hold / cancel / expire. Found while planning: cancel released seats
  with an unordered `UPDATE … WHERE booking_id`, while a chosen-seat hold locks seats in
  `(row, letter)` order **whatever their status** (its `locked` CTE does not filter on
  `status`). Hold `[12A, 12B]` vs cancel of the booking holding both can therefore wait in a
  circle → `40P01`. Plan: race test E measures it, then release locks seats
  `ORDER BY row, letter FOR UPDATE` first, shared by cancel and expiry. **Chosen by the
  student** after the Step 1 review: measure first (test E), then fix with the ordered lock CTE.

## Step 2 — Partial index for the sweep (`AddBookingHoldExpiryIndex`)

- `EXPIRED` was already allowed by `CHK_bookings_status` (Day 48A `MoveBookingsToLifecycle`):
  no constraint change.
- New migration: `idx_bookings_held_expiry ON bookings (hold_expires_at, id) WHERE status =
  'HELD'`. Partial, because holds are a small live slice while the other statuses grow for
  ever. **`id` in the key** because the sweep orders by `(hold_expires_at, id)` (a total,
  deterministic order); with `hold_expires_at` alone the plan gets an Incremental Sort.
- Plain `CREATE INDEX` (blocks writes while building): fine on dev data; a large live table
  would need `CONCURRENTLY`, which cannot run inside the per-migration transaction.
- **EXPLAIN (ANALYZE, BUFFERS)** of the sweep lookup on 100 000 seeded bookings (2 020 `HELD`,
  1 020 due; seeded and rolled back in one transaction):

  | | Plan | Buffers | Time |
  |---|---|---|---|
  | With the index | `Limit → LockRows → Index Scan using idx_bookings_held_expiry` | 104 | 0.06 ms |
  | Without | `Limit → LockRows → Sort → Seq Scan` (99 000 rows removed by filter) | 2 990 | 8.06 ms |

  The plan keeps `Filter: status = 'HELD'` although the index is partial: with `FOR UPDATE`
  Postgres re-checks the predicate on a row changed by a concurrent writer, so the qual stays.
- **Plan test** in `postgres-booking-repository.integration.test.ts` (`enable_seqscan = off`
  locally, as the Day 47 outbox test): the plan names `idx_bookings_held_expiry` and has no
  `Sort`. Mutations: index dropped → `Sort → Seq Scan`, fails; index on `hold_expires_at` only →
  `Incremental Sort`, fails; restored → passes.
- `down()` checked: revert drops the index, `up()` re-applies it.
- Integration count: 122 → 123.

## Step 3 — `expireDueHolds` on the port, Postgres, fake and contract

- **Port** (`booking-repository.ts`): `expireDueHolds(now, limit): Promise<ExpiredHold[]>`,
  `ExpiredHold = { bookingId, reference, flightId, ownerAccountId, holdExpiresAt, seats }`.
  No scope (the system acts on every account). The doc comment states the boundary
  (`<= now`), the order, skip-not-wait, and the seat lock order.
- **Postgres**: one statement, four CTEs —
  `due` (`… <= $1 ORDER BY hold_expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`) →
  `expired` (UPDATE only the rows `due` locked) →
  `locked` (their seats, `ORDER BY flight_id, row, letter FOR UPDATE`) →
  `released` (UPDATE exactly the locked rows). The final SELECT aggregates seats from
  `locked`, not the table: all CTEs share the pre-statement snapshot.
  - EXPLAIN of the whole statement: `locked` is `LockRows → Sort`, so seats are locked in the
    sorted order; `released` builds its hash from all of `locked` before touching the table.
  - `letter` is kept as `char(1)` inside `locked` (no `::text` cast), so `released`'s join can
    use `PK_flight_seats` on a large table instead of comparing a cast.
  - `flight_id` leads the lock order: a batch spans flights, and within one flight it is the
    `(row, letter)` order a chosen-seat hold uses.
- **Fake** (`tests/fakes/in-memory.ts`): same filter, order, limit; nothing to skip.
  One hand-written `BookingRepository` literal (`create-booking.test.ts`) gained the method.
- **Contract +5** (both tiers): deadline exactly `now` → expired, seat released; `now + 1 ms` →
  untouched; CONFIRMED / CANCELLED / EXPIRED with past deadlines untouched; `limit` + order
  (deadline, then id on a tie) across three calls; multi-seat hold released in `(row, letter)`
  order, passengers' seat copy kept, the same seats can be held again.
- Mutation `<=` → `<` in the sweep: 2 contract cases fail on Postgres; reverted.
  The seat lock order is invisible to sequential tests: race test E (Step 6) covers it.
- Counts: unit 351 → 356, integration 123 → 128. Typecheck (src + tests) clean.

## Step 4 — Use case, job, event, and a scheduler that waits on stop

- **Audit**: `AuditActor` is now `account | system`; `AuditAction` gains `BOOKING_EXPIRED`.
  No migration (Day 38 loose `CHECK`s). Actor constant `HOLD_EXPIRY_ACTOR =
  system/booking-hold-expiry`.
- **Contract** `packages/contracts/src/booking-expired-event.ts`: `booking.expired` with
  `booking { id, reference, flightId, holdExpiresAt, seats }`; `occurredAt` is when the job
  expired it. The plan's separate `expiredAt` was dropped: it would always equal
  `occurredAt`. Seats must be a non-empty array of codes. Built to `dist`.
- **Notifier**: `booking-expired-consumer.ts` logs `booking_expired_consumed` with reference
  and `seatCount` (no names); subscribed to the `booking-expired` queue. +2 tests (valid,
  9 invalid payloads rejected without logging).
- **Use case** `api/src/bookings/expire-holds.ts` (`createExpireHolds`): `now` read once per
  run; up to `maxBatches` transactions, each `expireDueHolds(now, batchSize)` + one audit
  entry + one outbox event per booking; stops when a batch comes back short. Returns
  `{ expired, batches, exhausted }`. Correlation id = the event's own id (no request).
- **Job** `api/src/jobs/booking-hold-expiry-job.ts`: silent when nothing was due,
  `booking_holds_expired` when it expired some, `warn booking_hold_expiry_backlog` when a run
  hit its batch limit (seats then stay `HELD` past the deadline for another interval).
  Registered in the Composition Root: 60 s, batch 50, max 20; option `holdExpiryIntervalMs`.
- **`JobScheduler.stop(): Promise<void>`** now waits for the run in progress (`running`
  promise per job, never rejects) and starts none; `close()` awaits it before closing the
  publisher and the DataSource, so a run is never cut off mid-transaction.
  The existing "no overlap" test ended with a run still blocked, so `await stop()` hung there:
  correct new behavior, the test now releases the run first.
- **Tests**: `expire-holds.test.ts` +6 (deadline reached → EXPIRED + seats + exact audit +
  event checked through the notifier's parser; 1 ms before → nothing; 2+2+1 batches;
  `maxBatches` → `exhausted`, next run takes the rest; `now` read once, with a clock that moves
  right after the read; audit failure rejects). `booking-hold-expiry-job.test.ts` +2.
  `job-scheduler.test.ts` +1 (stop waits for the in-flight handler).
- Mutations: `stop()` not awaiting the runs → the new scheduler test fails; reading the clock
  per batch → the "now once" test fails. Both reverted.
- Batch rollback on failure is database semantics: proved on Postgres in Step 6, not on the fake.
- Counts: unit 356 → 365, notifier 8 → 10, integration 128, identity 12. Typecheck clean.

## Step 5 — Effective status on read, cancel with the deadline in its WHERE

- **`api/src/bookings/booking-lifecycle.ts`** (pure): `isHoldLapsed` (the one TypeScript copy of
  BR-BOOK-10, `<=`), `effectiveBookingStatus`, `withEffectiveStatus`, and
  `classifyNotCancelled` (CANCELLED → already-cancelled; EXPIRED or lapsed HELD → expired;
  anything cancellable → throws, because then the SQL and the rule disagree). The plan's
  `toBookingView` became `withEffectiveStatus`: the read model is the same `Booking` type.
- **Reads**: GetBooking, GetBookingByReference and ListBookings take `getCurrentTime` and
  return lapsed holds as `EXPIRED` (list: one `now` per page). CreateBooking unchanged.
- **Port `cancel(bookingId, scope, now)`**, new outcome `expired`. Postgres:
  `WHERE id = $1 AND (status = 'CONFIRMED' OR (status = 'HELD' AND hold_expires_at > $2))`.
  The follow-up read stays scoped and classifies through `classifyNotCancelled`.
- **Ordered seat release, shared**: `releaseSeatsOf(source)` builds the `locked` (`ORDER BY
  flight_id, row, letter FOR UPDATE`) + `released` CTEs; cancel and expireDueHolds both use it.
  This is the fix for the lock-order risk of Step 1. Its "before" state is reproduced inside
  race test E (Step 6) as a control query, the way Day 48A test B kept its unordered control.
- **Use case**: `now` read once, before the transaction, used for the decision and the
  audit/event time; non-`cancelled` outcomes pass through. **Route**: `expired` →
  `409 BOOKING_EXPIRED` "Booking hold has expired". Composition Root passes clocks to reads.
- **Tests** (+12 unit, +3 integration):
  - contract +3 on both tiers: cancel at the exact deadline → `expired`, nothing written, and
    the sweep at that same instant takes it (the two sides are complementary); 1 ms before →
    cancelled; a swept EXPIRED → `expired`, another account's lapsed hold → `not-found`.
    Existing contract cancel calls use `CANCEL_AT`, before every fixture hold lapses.
  - `booking-lifecycle.test.ts` +3, `get-booking.test.ts` +1 (lapsed reads EXPIRED, stored row
    still HELD), `cancel-booking.test.ts` +1 (expired: no audit, no event, seat still held).
  - `bookings.api.test.ts` +4 with a movable clock shared by every use case: GET by id / by
    reference / list show `EXPIRED` while the seat map still shows `HELD`; DELETE lapsed → 409
    `BOOKING_EXPIRED`, nothing written; DELETE swept → same 409; other account → 404, owner
    1 ms before the deadline → 204.
- **Mutations** (Postgres contract): `> $2` → `>=` → the exact-deadline case fails; deadline
  check removed (kept `$2` referenced, so the SQL still parses) → the same case fails. The
  first attempt dropped `$2` entirely and failed 14 tests with a parameter-type error — not
  evidence, so redone. Both reverted.
- Counts: unit 365 → 377, integration 128 → 131. Typecheck clean.

## Step 6 — Race tests, e2e, docs

### Race file `postgres-booking-expiry-race.integration.test.ts` (9 tests, real use cases, pool 10)

Every test ends on invariants read from the tables: no seat owned by an ended booking, HELD
seats = passengers of HELD bookings, one ending audit entry per booking.

```text
A  4 sweepers, batches of 7, 50 due holds; each batch keeps its locks 100 ms
   → 50 expired once each (50 audit, 50 outbox), 12–13 overlapping batch pairs, ~250 ms
B  control, same sweep with plain FOR UPDATE (test-only repository)
   → still 50 once each (waiters re-check status), 0 overlapping batches, ~910 ms
C  cancel + sweep at the deadline, 20 rounds → expiry 20/20, cancel `expired`, one end each
C' cancel at deadline − 1 ms vs sweep at deadline → one end each; splits 16/4, 20/0, 19/1, 18/2
D  sweep vs a new auto hold on the only seat it frees → never shared; refused 20/20 here
   (the auto hold skips the seat the sweep still locks)
E  gate transaction holds 12A; hold [12A, 12B] queues on it; then the release arrives
   control (release locks 12B before 12A) → 40P01 5/5
   real cancel / real sweep → no deadlock 5/5 each; hold `seats-unavailable`, then release
F  batches of 2, audit fails on the 3rd record → first batch committed, second rolled back
   whole (status, seats, outbox), next run expires it
10 runs in a row: 9/9 every run, same numbers.
```

Two test bugs found on the way, both in test code:
- The control's `UPDATE flight_seats SET booking_id = NULL … RETURNING seat.booking_id` returns
  the **new** row (NULL), so the join to `expired` was empty → B saw 0 expired. Returns the id
  from the CTE now.
- Test F assumed the first-created hold is in the first batch; equal deadlines are ordered by
  `id` (random UUID). Asserts counts and finds the one left instead.

**Test E was redesigned after a mutation survived.** The first version released inside a
transaction kept open *after* its statement; the real release is one statement that locks both
seats before the hold can arrive, so the order was invisible: mutating the release to `DESC`
stayed green. The gate on 12A forces the hold to queue first, so the release order decides.

Mutations on `src/` (each reverted, file compared byte for byte with the backup):

| Mutation | Result |
|---|---|
| sweep without `SKIP LOCKED` | A fails (no overlapping batches) |
| release `ORDER BY … DESC` | both real E tests fail with `40P01` |
| release without `ORDER BY` | **survives** — physical order is (row, letter); recorded in ADR-004 / Decision 12 |
| sweep `<=` → `<`; cancel `>` → `>=` / no deadline | repository contract fails at the exact instant (Steps 3, 5) |
| `stop()` not awaiting; clock read per batch | unit tests fail (Step 4) |

### End-to-end (docker compose: app + notifier rebuilt; identity dev process)

```text
Seed re-run. e2e48b-admin (promoted), e2e48b-user, e2e48b-other. Flight on VN-B210 (68 seats).
1. user holds [10C, 10D] → 201 HELD, reference CJMZ6C, deadline +15 min; availableSeats 66   ✅
2. psql: hold_expires_at = now() − 1 s. Stored HELD; GET by id / by reference / list →
   EXPIRED; seat map 10C 10D still HELD                                                       ✅
3. DELETE (owner) → 409 BOOKING_EXPIRED; other account → 404; stored still HELD,
   no BOOKING_CANCELLED audit                                                                   ✅
4. job ran 13 s later: stored EXPIRED, 10C 10D AVAILABLE, availableSeats 68                    ✅
5. other user holds exactly [10C, 10D] → 201 HELD; old booking DELETE → 409 BOOKING_EXPIRED    ✅
6. audit BOOKING_EXPIRED actor system/booking-hold-expiry, metadata seats "10C,10D";
   outbox booking-held + booking-expired both published; app log booking_holds_expired
   {expired: 1, batches: 1}; notifier booking_expired_consumed (reference, seatCount 2,
   correlationId = eventId); 0 seats owned by an ended booking; no job_failed               ✅
docker compose stop app → server_shutdown_started / completed, clean.
Postman via newman: "Day 48B — Hold expiry (1 of 2)" 5 requests / 6 assertions / 0 failed,
psql between, "(2 of 2)" 7 / 9 / 0 (waits 65 s for the job); "Day 48A" 14 / 21 / 0.
```

Containers left as found: `postgres` and `rabbitmq` running, `app` and `flight-notifier`
stopped, identity dev process stopped.

**Docs:** README (new "Hold expiry" section, `409 BOOKING_EXPIRED`, audit `BOOKING_EXPIRED`
with the `system` actor, jobs table incl. the relay, messaging and notifier, migration table,
application flow, limitations: seat-map lag ≤ ~60 s, head-of-line batch, expiry is
multi-instance safe but the relay is not, every hold now expires until payment exists);
Postman (two Day 48B folders + README step 15 with the psql command); domain-model Existing
column (BR-BOOK-04/06/10, gap table) and the lock-order paragraph with the measured result;
ADR-004 Day 48B addendum; English note `hold-expiry-and-time-boundaries.md`; Vietnamese notes
(`on-tap-nhanh-day-01-48b.md` renamed from 48a and links fixed, `race-conditions/08`, interview
Q&A in concurrency / testing / operations / architecture, use-cases bookings + jobs + index,
`migrations/danh-sach.md` #20, "Cập nhật đến Day 48B"; every relative link checked).

## Test count reconciliation

```text
Unit (api):   351 (Day 48A) + 5 (Step 3: contract on fake)
              + 9 (Step 4: 6 expire-holds, 2 job, 1 scheduler)
              + 12 (Step 5: 3 contract on fake, 3 lifecycle, 1 get-booking, 1 cancel, 4 HTTP) = 377
Integration:  122 + 1 (Step 2: plan test) + 5 (Step 3: contract) + 3 (Step 5: contract)
              + 9 (Step 6: A, B, C, C', D, E control, E cancel, E sweep, F) = 140
Notifier:     8 + 2 = 10.   Identity: 12 (unchanged).
```

## Not today

- **Payment / `CONFIRMED`** (step 6): uses the `> now` side of BR-BOOK-10 and gets the
  payment-vs-expiry race test. Until then every new booking expires after 15 minutes.
- The seat map lags the deadline by up to one job interval (accepted, Decision 12).
- Splitting a failing batch to isolate one bad booking (head-of-line accepted, like Day 24).
- The release `ORDER BY` survivor: no test can see it while the physical order matches.
- Carried: BR-BOOK-03 pricing, removing the `booking-created` contract once its queue is empty,
  the `SKIP LOCKED` multi-seat edge (accepted in Step 0), outbox relay not multi-instance safe.

## DAY 48B SUMMARY

Holds now expire. A batched `SKIP LOCKED` job (60 s, 50 × 20) marks lapsed holds `EXPIRED`,
frees their seats, and writes one `BOOKING_EXPIRED` audit entry (system actor) and one
`booking-expired` event per booking; reads show `EXPIRED` from the deadline on; cancel checks
the deadline in its own `WHERE` and answers `409 BOOKING_EXPIRED`. One boundary, two
complementary sides (`<=` / `>`), pinned at the exact instant on both storage tiers. A partial
index serves the sweep in order (104 vs 2 990 buffers on 100 000 bookings). Planning the lock
order found that releasing seats in scan order can deadlock with a chosen-seat hold; a gate
transaction reproduced it 5/5 and one shared ordered-lock CTE removed it. `stop()` now waits for
a running job, so shutdown never cuts a batch off mid-transaction.

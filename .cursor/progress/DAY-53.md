# Day 53 — Read-only admin reports (phase D step 10, phase D complete)

> Status: ✅ Complete.
> - Tests: unit 640/640, integration 309/309 (on `booking_test`), notifier 20/20, identity 12 + 7 (unchanged, not touched).
> - Postman: the whole collection (206 requests) green twice in a row with `./postman/run-all.sh`.
> - e2e: 5 HTTP scenarios on the compose stack.
>
> Three admin reports (manifest, load factor, audit log) behind a second read port, `AdminReports`.
> - The manifest is read from one `REPEATABLE READ READ ONLY` snapshot and the view is audited.
> - The first audit indexes are shaped by the query that reads them.
> - The day also records a read-side evidence table for the Day 54 retrospective.
>
> Decision 19. No ADR: no option rejected today was a real alternative of the size of ADR-009..011.

## Working rules kept

- Vietnamese chat; English repo files except `docs/learnings/vietnamese/`.
- Plan first, then one step at a time, with an explanation and reconciled test counts after each.
- **No git commit**: suggested message at the end.
- Asked before rebuilding the app, migrating `booking_db`, creating e2e data and starting the stopped docker stack.
- Integration only on `booking_test`, one suite at a time.

## Step 0 — Day 52 review items

1. **Payment phase 1 refuses a booking whose flight is `CANCELLED`.**
   - New not-payable reason `flight-cancelled`: `409 BOOKING_NOT_PAYABLE`, stored with the key.
   - The gateway is not called and no payment row is created.
   - The condition is "not cancelled", not "on sale": BR-PAY-06 keeps a valid hold on a `CLOSED`
     flight payable.
   - The flight is read without a lock; phase 3 stays the last fence (Day 52 race B1–B4 still pass).
   - `pay-for-booking.ts` gained `flightRepository`.
2. **Cascade-complete marker.**
   - `flights.cascade_completed_at` (migration `AddFlightCascadeCompletedAt`).
   - CHECK: only a `CANCELLED` flight may carry the mark.
   - Backfill, and a partial index `idx_flights_cascade_pending`.
   - The job marks a cancelled flight once its claim finds nothing and no live booking is left. This
     is final because a `CANCELLED` flight can never gain a live booking again; the argument is
     written next to the port method.
   - New global invariant: "a flight whose cascade is complete has no live booking".
   - **EXPLAIN** on 20 400 flights / 812 completed cancellations: the column alone was not enough.
     `ORDER BY booking.id LIMIT 1` made the planner walk every live booking by primary key (39 213
     buffers with nothing to claim). Ordering by `flight.id, booking.id` starts from the pending
     flights: **1 buffer, 0.1 ms**; 5.9 ms with one pending flight.
3. **The whole Postman collection runs again on any `booking_db`.**
   - A **Setup** folder runs first and draws a run code, three unused airport codes and a date shift
     (the first date lands 30 days ahead).
   - It registers this run's airports and copies of the five seeded aircraft layouts.
   - Literals in every folder became variables: flight numbers, registrations, SGN/HAN, and dates in
     bodies, URLs and test scripts.
   - Flights (Read) now runs after Flights (Write).
   - `postman/run-all.sh` starts identity if needed, promotes alice, then runs newman in two parts
     with the Day 48B psql step between them.
   - **Finding:** newman exports environment variables but not runtime collection variables, so the
     run data lives in the environment.
   - Two consecutive runs green.

## Step 1 — Decision 19, US-ADM-01..03

Six decisions with reasons. The cursor Pause & Think: the audit cursor stays a SHA-256 binding, not
an HMAC. It carries a position only, the filter always comes from the request, and the caller is an
admin who may run any filter. A narrower role's restriction would go in the `WHERE`, never in the
cursor.

## Step 2 — `AdminReports`, three reports, indexes

- **Port** `src/reports/admin-reports.ts`. **Adapter** `postgres/postgres-admin-reports.ts`. **SQL**
  `postgres/admin-reports-sql.ts`, with explicit column lists only.
- **Use cases:** `get-flight-manifest.ts`, `get-load-factor.ts`, `query-audit-log.ts`.
- **Supporting files:** validation, `report-cursor.ts`, `report-views.ts`.
- **Fake** in `tests/fakes/in-memory.ts`. **Contract** `tests/contracts/admin-reports.contract.ts`, on
  both tiers.
- **Routes:** `GET /api/admin/flights/:id/manifest`, `/api/admin/reports/load-factor`,
  `/api/admin/audit-logs`, all with `requireJwt` + `requireRole("admin")`.
- **Manifest view audit:** `FLIGHT_MANIFEST_VIEWED`, metadata `{ passengerCount }`, recorded in its
  own transaction after the read. If that write fails the response is `500` and the manifest is not
  sent.
- **Load factor:** a widened UTC window (UTC+14 to UTC−12) on `idx_flights_departure`, then the exact
  local date per origin. Seats for the whole page are counted in one statement.
- **Migration `AddReportIndexes`:** two audit indexes plus the flights departure index, built
  `CONCURRENTLY` with `transaction = false`.
- **Statement counts pinned:**
  - manifest = `START TRANSACTION`, `SET … REPEATABLE READ`, `SET … READ ONLY`, 2 queries, `COMMIT`;
  - load factor and audit = 1 each, for any page size.
- **Volume and EXPLAIN:** `perf:reports:seed` (300 000 audit rows) and `perf:reports:explain`, before
  and after the migration (tables below).

## Step 3 — Snapshot consistency

`tests/integration/postgres-admin-reports-snapshot.integration.test.ts`:

| Test | Result |
|---|---|
| Gate between the manifest's statements; a 2-passenger booking cancelled and committed meanwhile | 3 booked, 3 passengers: consistent, the world before the cancel |
| Control, test-only: the same statements at READ COMMITTED | **3 booked above 1 passenger** |
| Load factor (one statement): 20 reads against 10 concurrent hold/cancel/rebook writers | every class adds up on every read |

- **Mutation:** the adapter set to `READ COMMITTED` → the snapshot test fails (`1 ≠ 3`).
- **Stability:** 10 consecutive runs green.

## Step 4 — Verification matrix A–G

`tests/integration/admin-reports.differential.integration.test.ts`:

- **A/B.** Load factor, paged with a random limit, against `naiveLoadFactor` (no `src/` imports, its
  own zone table, Intl, seats counted from the world it built), over 30 seeded worlds × 6 queries.
  - The worlds mix cancelled and scheduled flights, lapsed unswept holds, two classes, and London DST
    dates.
  - Every class of every page satisfies `available + held + booked = total`.
- **C.** Manifest against `flight_seats`, on bookings made through the real repository (hold,
  confirm, cancel, lapsed), with the global invariants holding.
- **E.** The audit log walked page by page (limits 1/7/50/100) through 240 entries on only 12
  instants: every entry once, newest first.
- **D, F, G** are covered by the contract and API tests of Step 2.
- **Mutations**, all caught:
  - a lapsed hold counted as held → A and C fail;
  - the local date read in UTC → A fails;
  - keyset `<` → `<=` → E fails.

## Evidence for Day 54: the read side

The question for Day 54 is whether this system needs a separate read model (CQRS) or a mediator
(phase E), and for which reason. The table records what was measured. It does not argue for an
answer.

### Every meaningful read, measured

Conditions:
- `booking_test` generated by `perf:search:seed` + `perf:reports:seed`: 20 400 flights,
  3.88 M flight seats (1.86 M booked), 19 595 bookings (all owned by one account), and 300 000 audit
  entries over 55 715 targets.
- Each read goes through the adapter production uses (`npm run perf:reads:measure`). One warm-up
  run, then 7 runs. The table shows the median and the worst of the 7.
- Wall time is measured in the Node process and includes the driver and the mapping, but no HTTP.
  One client, no concurrent load, warm cache, after `VACUUM (ANALYZE)`.
- Two runs. Both medians are shown.

| Read | Port | Tables | SQL statements | Median (run 1 / run 2) | Worst | Through a domain repository? |
|---|---|---|---|---|---|---|
| Search SGN→HAN, 3 days, 2 passengers, page of 20 | `FlightSearch` | flights, airports, flight_fares, flight_seats | 1 | 7.6 / 11.7 ms | 11.2 / 38.0 ms | No (read port, Day 51) |
| Flight details, fullest flight | `FlightSearch` | flights, airports, flight_fares, flight_seats | 1 | 1.2 / 0.9 ms | 1.5 / 1.0 ms | No (read port) |
| Seat map, fullest flight | `FlightRepository` (`findById` + `findSeats`, in parallel) | flights, airports, flight_fares, flight_seats | 4 | 2.1 / 2.3 ms | 3.5 / 3.9 ms | **Yes** |
| My bookings, page of 20, owner of 19 595 bookings | `BookingRepository.findPage` (OFFSET) | bookings, booking_passengers | 3 (count, page, passengers) | 3.9 / 3.3 ms | 5.4 / 6.1 ms | **Yes** |
| Manifest, fullest flight | `AdminReports` | flights, airports, flight_seats, bookings, booking_passengers | 2 in one REPEATABLE READ READ ONLY transaction | 9.2 / 4.9 ms | 13.2 / 5.9 ms | No (read port, today) |
| Load factor, 31 days, all routes, page of 50 | `AdminReports` | flights, airports, flight_seats, bookings | 1 | 8.4 / 8.1 ms | 9.2 / 8.7 ms | No |
| Audit log, one booking, page of 50 | `AdminReports` | audit_logs | 1 | 0.7 / 0.6 ms | 0.9 / 0.8 ms | No |
| Audit log, 1-day range, page of 100 | `AdminReports` | audit_logs | 1 | 1.2 / 0.8 ms | 1.5 / 0.8 ms | No |

What `EXPLAIN (ANALYZE, BUFFERS)` showed for the reports:
- Median of 6 runs after one warm-up. EXPLAIN ANALYZE adds timing overhead, so compare buffers
  rather than milliseconds.
- `npm run perf:reports:explain -- <label>`, before and after the `AddReportIndexes` migration.

| Query | Before | After |
|---|---|---|
| Audit, one booking | Seq Scan on audit_logs, 48.8 ms, 6 538 buffers | `idx_audit_logs_target_occurred`, 0.08 ms, 19 buffers |
| Audit, one flight + action | Seq Scan, 30.8 ms, 6 444 buffers | same index, 0.03–0.07 ms, 8 buffers |
| Audit, 1-day range | Seq Scan, 30.5 ms, 6 538 buffers | `idx_audit_logs_occurred`, 0.1 ms, 36 buffers |
| Audit, 31 days + one account | Seq Scan, 26.9 ms, 6 538 buffers | bitmap on the time index, 17–38 ms, 6 701 buffers: actor has no index (Decision 19), so all ~51 000 entries in the range are read to find ~100 |
| Load factor, 31 days, 50 flights | 27–33 ms, ~9 800 buffers | 21–47 ms, ~9 700 buffers: `idx_flights_departure` picks the 51 flights in 5 buffers; the rest is counting ~9 400 seats on 8 963 heap blocks |
| Manifest statement 1 | 6.4 ms, 554 buffers | 5–13 ms, 554 buffers |

### Counted from the code

| What | Count | Where |
|---|---|---|
| Read ports | **2** | `FlightSearch` (Day 51), `AdminReports` (Day 53) |
| Repositories | **7** | five for aggregates (Flight, Booking, Payment, Airport, Aircraft) and two for infrastructure (Idempotency, Outbox) |
| Reads still served by a domain repository | **4** | seat map and the admin flight list (`FlightRepository`), my bookings and a booking by id or reference (`BookingRepository`) |
| Write use cases shaped "transaction + write + audit + outbox" | **5** | create-booking, cancel-booking (the shared core), expire-holds, create-flight, settle-payment |
| Write use cases shaped "transaction + write + audit" (no event) | **6** | register-airport, register-aircraft, open-flight, cancel-flight, change-seat, the refund record in reconcile-payments |
| Background jobs | **6** | flights-summary, outbox-relay, booking-hold-expiry, payment-reconciliation, idempotency-key-cleanup, flight-cancellation-cascade |
| Jobs shaped "claim with `SKIP LOCKED` + process + record" | **4** | hold expiry (batch), reconciliation (batch + lease), key cleanup (batch), cascade (one at a time). The outbox relay has no `SKIP LOCKED`, which is the known "not multi-instance safe" item; the summary job only reads. |

### What the numbers say, and what they do not

- **No read is slow at this volume.** Every median is under 12 ms with one client. Performance on
  its own is not today's reason for a separate read model.
- **The cost that grows is counting seats.**
  - Load factor and the manifest count `flight_seats` rows on every request. Their cost scales with
    the number of seats read (about one heap block per seat after the seed's updates), not with the
    page size.
  - The two possible fixes are a covering index and a stored per-class counter. The counter is a
    small read model, and it would have to be kept correct by every hold, confirm, cancel, expiry and
    seat change.
  - Not needed at 50 flights per page. It would be needed if a report ever counts thousands of
    flights at once.
- **The read side has already split off without a mediator.** Two read ports exist next to the
  repositories, each added the day a read needed its own shape. That is CQRS at the level of ports,
  with no bus and no second store.
- **The repetition is on the write side.** 11 use cases open a transaction, write, and record an
  audit entry; 5 of them also enqueue an event; 4 jobs share the claim shape. If phase E brings a
  mediator or pipeline, this repetition is the measured reason to name, not read latency.
- **Not measured:** concurrent load, a cold cache, and HTTP or serialization time. Every number
  above is one client on a warm cache.

## Step 6 — e2e, Postman, docs

**e2e on the compose stack** (`booking_db`, its own aircraft `VN-RFC43`, flight `VN53FC43` on 2027-01-15):

| # | Scenario | Result |
|---|---|---|
| 1 | Manifest of a flight with two paid bookings and one hold | `200`. Passengers 1A, 10A, 10B in seat order, four fields each; the hold (12C) counted (`heldBookings: 1`), never named; BUSINESS booked 1, ECONOMY booked 2 / held 1 |
| 2 | Load factor of the flight's local date against the public seat map | Every class adds up and matches the seat map; BUSINESS 1/8 (`0.125`), ECONOMY 2/168 (`0.0119`) |
| 3 | Audit log of one booking | `BOOKING_CREATED → BOOKING_CONFIRMED → BOOKING_SEAT_CHANGED → BOOKING_CANCELLED`, and on its payment `PAYMENT_REFUND_PENDING → PAYMENT_REFUNDED` (reconciliation after 24 s); the manifest view audited once with `passengerCount: 3` |
| 4 | Cancel a booking, then both reports again | Manifest lists 1A only; load factor ECONOMY sold 0, held 1 |
| 5 | A user calls the three reports | `403` each |
| 6 | Whole Postman collection twice | See below |

- **App and notifier logs after the run:** 0 occurrences of any passenger name (111 app lines,
  6 of them manifest requests).
- **Migrations on `booking_db`:**
  - `AddFlightCascadeCompletedAt` ran at the Step 0 rebuild. The 2 cancelled flights were backfilled
    as complete.
  - `AddReportIndexes` ran at the Step 6 rebuild. Both audit indexes are valid.

**Postman:**
- New folder "Day 53 — Admin reports": 16 requests, 23 assertions.
- It builds its own flight on the run's A588 copy and covers 403, 200, 404, 422, 400 and 401.
- `./postman/run-all.sh` twice in a row:

| Run | Part 1 | psql | Part 2 | Failures |
|---|---|---|---|---|
| 1 | 91 requests, 111 assertions | `UPDATE 1` | 116 requests, 123 assertions | 0 |
| 2 | 91 requests, 111 assertions | `UPDATE 1` | 116 requests, 123 assertions | 0 |

**Docs:**
- `domain-model.md`: Decision 19; Decision 18 bullet on the completion marker; BR-PAY-06 and
  BR-AUTH-03; step 10 done; "Status after Day 53: phase D is complete".
- `scope.md`: US-ADM-01..03 acceptance criteria.
- ADR-011: trade-offs updated.
- `README.md`: Admin reports section, `FLIGHT_MANIFEST_VIEWED`, the job row, two migrations, the
  limitations list.
- `postman/README.md`: run-all section, step 22.
- `docs/learnings/report-snapshots-and-query-shaped-indexes.md` plus its index row.
- Vietnamese notes:
  - quick-review file renamed to `-53`;
  - `race-conditions/15`;
  - `use-cases/admin-reports.md`;
  - interview: database Q16–17, security Q10–11, architecture Q13, testing Q16;
  - migrations 30–31;
  - "Cập nhật đến Day 53";
  - link check: 35 files, 0 broken.

**Roadmap:** not changed. The order of phases is the same. Step 10 was always in phase D, and the
retrospective moves from "Day 53" (CURRENT.md's guess) to Day 54, which the roadmap does not number.

## Incidents

- **The integration suite hung after Step 0.** Six Day 52 race assertions compared the cascade's
  result against its old shape. Test C1 failed while its gate transaction was still open, and the
  next test's `TRUNCATE` waited forever.
  - Fixed the expectations.
  - `test:integration` gained `--test-timeout=120000 --test-force-exit`.
- **The unit suite hung once on `flights.api.test.ts`.** It did not reproduce in three runs alone
  (0.4 s each). The `test` script gained `--test-timeout=60000`, so a repeat fails with a name.
- **The first full Postman run** failed 2 of my own Setup assertions (`BUSINESS: 0` is present for an
  economy-only layout).
- **The second full Postman run** could not hand the Day 48B reference to the psql step: newman does
  not export runtime collection variables. The run data moved to the environment.
- **Fixture overlap** in the reports contract: a flight inside the previous one's 45-minute
  turnaround. A trailing base64 character does not damage a cursor; the test changes a middle one.
- **A heredoc full of `$1`** in SQL tripped a shell safety check; the file was written with the
  editor instead.
- **The docker stack had stopped** between sessions; it was started after asking.

## Test reconciliation

| Suite | Before (Day 52) | Removed | Added | After |
|---|---|---|---|---|
| Unit | 614 | 0 | +26 | **640** |
| Integration | 292 | 0 | +17 | **309** |
| Notifier | 20 | 0 | 0 | 20 |
| Identity | 12 + 7 | 0 | 0 | 12 + 7 (not run, untouched) |

**Unit +26:**
- `pay-for-booking.test.ts` +1, `bookings.api.test.ts` +1.
- `flight-cancellation-cascade-job.test.ts` +1, `cascade-flight-cancellations.test.ts` +1.
- Booking contract (fake) +1.
- `admin-reports.contract.test.ts` +7, `report-validation.test.ts` +4, `report-cursor.test.ts` +3,
  `admin-reports.api.test.ts` +7.

**Integration +17:**
- Booking contract (Postgres) +1, `invariants.integration.test.ts` +1.
- `admin-reports.contract.integration.test.ts` +7.
- `postgres-admin-reports.integration.test.ts` +2.
- `postgres-admin-reports-snapshot.integration.test.ts` +3.
- `admin-reports.differential.integration.test.ts` +3.

## Not today

- **Load factor and the manifest count seats on every request.** Two options: a covering index on
  `flight_seats (flight_id, fare_class, status, booking_id)`, or a per-class counter (a small read
  model kept by every seat write). Evidence for Day 54, not needed at 50 flights a page.
- **The audit log by actor alone over a long range** reads the whole range. It gets an index when a
  query needs "what did X do".
- **No retention for `audit_logs`.** It only grows, and nothing archives it.
- **The intermittent unit hang** (`flights.api.test.ts`) is now visible by name if it recurs, but its
  cause is unknown.
- **The outbox relay is not multi-instance safe**, and consumers do not dedupe by `eventId` (carried).
- **Carried from Day 52:**
  - `REFUND_FAILED` has no endpoint or alert;
  - a cancel can be delayed by a stream of holds;
  - the simulator's provider memory is in-process;
  - no fare-change endpoint;
  - deprecated `priceInCents`;
  - the `booking-created` contract removal;
  - no fare-class filter in search.

## Summary

Phase D is complete:
- a booking domain with seats, fares, payments, reconciliation, cancellations, a flight cascade,
  search and admin reports;
- every contested write has its race test and control;
- every read is under 12 ms at 3.9 M seats.

Day 54 judges phase E on the evidence table above:
- the read side has already split into two ports without a mediator;
- the measurable repetition is on the write side (11 use cases, 4 jobs).

## Suggested commit message

```text
feat(api): read-only admin reports and phase D complete (Day 53)

AdminReports read port: flight manifest (CONFIRMED only, four fields per passenger, held bookings
counted not named, two statements in one REPEATABLE READ READ ONLY snapshot, every view audited as
FLIGHT_MANIFEST_VIEWED), load factor by the origin's local dates (31 days, keyset pages), audit log
with a required target or range and the first audit indexes shaped by that query (AddReportIndexes,
CONCURRENTLY). Payment phase 1 refuses a cancelled flight; flights.cascade_completed_at and a
flight-first claim (39 213 to 1 buffer). Whole Postman collection rerunnable via a Setup folder and
postman/run-all.sh. Decision 19; gated snapshot race with a READ COMMITTED control; differential,
inventory and paging matrix with mutations; read-side evidence table for Day 54.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

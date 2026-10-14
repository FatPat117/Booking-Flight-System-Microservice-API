# Day 47 — FlightSeat inventory + seat map (phase D, step 4)

> ✅ Complete. Each flight owns a copy of its aircraft's seats (`flight_seats`); the
> `available_seats` counter is gone and counted on read; booking claims a concrete seat with
> `FOR UPDATE SKIP LOCKED`, cancel releases it in the same statement; public seat map.
> Unit 321/321, integration 102/102, race file 10× in a row, e2e on docker compose, Postman folder.

## Step 0 — Day 46 leftovers closed

- **40P01 → `aircraft-unavailable`** kept (option b), with its assumption written next to the
  mapping in `postgres-flight-repository.ts`: the flight insert is the first write of
  CreateFlight's transaction; anything written after it (today: the flight's seats) only touches
  rows no other transaction can see yet. A write added *before* it breaks the assumption → retry
  instead. Retry at the `TransactionRunner` level was rejected: it would replay audit + outbox for
  one known cause.
- **IMMUTABLE condition** written in `AddAircraftScheduleExclusion` and
  `docs/learnings/exclusion-constraints.md`: true only while the interval has no day/month part
  (`'1440 minutes'`, never `'1 day'`).
- **`booking-cancelled` queue** listed in README limitations with the concrete next step.

## Step 1 — Decisions (Decision 10 in `docs/product/domain-model.md`)

1. FlightSeat is a copy of the aircraft's seats, not a reference (no FK to `seats`).
2. The link lives on `flight_seats.booking_id`, beside BR-SEAT-01.
3. Statuses `AVAILABLE` / `BOOKED` only; `CHK_flight_seats_booking` ties `booking_id` to status.
4. One booking ↔ at most one seat (`UQ_flight_seats_booking_id`); FK to bookings is
   `DEFERRABLE INITIALLY DEFERRED` because CreateBooking claims the seat before inserting the booking.

## Step 2 — Expand / backfill / contract on dev data

Dev `booking_db` was stale (4 migrations, Day-39 era `app` container). Reset: stopped `app`, dropped
and recreated `booking_db` with the init-script owner/REVOKE, ran migrations up to Day 46 only,
`seed:reference`, then inserted deliberately shaped data:

| Flight | Aircraft (seats) | `available_seats` | Active bookings | Intent |
| --- | --- | --- | --- | --- |
| VN701 | VN-B210 (68) | 66 | 2 (+1 cancelled) | consistent |
| VN702 | VN-A321 (176) | 120 | 1 | legacy counter drift |
| VN703 | VN-B210 (68) | 0 | 70 | oversold vs. aircraft |

**Run 1:** expand + backfill applied; contract refused (whole migration rolled back, column kept):

```
booking 6bb71325-… on VN703: no seat left on aircraft VN-B210
booking 7d2b1aea-… on VN703: no seat left on aircraft VN-B210
flight VN702: available_seats = 120, AVAILABLE flight_seats = 175
```

Backfill pairing checked: earliest active booking → front-most seat (VN701 Alice `1A`, Carol `1C` —
ATR row 1 is `A C D F`), cancelled booking gets no seat, and the two seatless VN703 bookings were the
latest ones (Passenger 69, 70). VN701 (66 = 66) was not listed.

**Human decisions (per HINT):** cancelled the two seatless VN703 bookings; accepted the derived value
for VN702 (`available_seats = 175` — the 120 was wrong before today).

**Run 2:** contract applied, `available_seats` dropped. Result: every flight has
active bookings = BOOKED seats (VN701 2/66 available, VN702 1/175, VN703 68/0).

Constraint probes (each in a rolled-back transaction): BOOKED without booking → `CHK_flight_seats_booking`;
AVAILABLE with booking → same; one booking on two seats → `UQ_flight_seats_booking_id`; `HELD` →
`CHK_flight_seats_status`; seat claimed before the booking insert in the same transaction → OK
(deferred FK); seat pointing to a booking never inserted → FK violation at `COMMIT`.

## Step 3 — Seat inventory created with the flight

- `FlightRepository.create()` writes the flight **and** its seats: after the flight insert, one
  `INSERT INTO flight_seats ... SELECT ... FROM seats WHERE aircraft_id = $2` — no seat list in
  TypeScript. Same aggregate → same repository, like `Aircraft` + `seats` (Day 45): atomic on its
  own (inside a TransactionRunner it joins; outside one it opens its own).
- The 40P01 assumption still holds: the seat insert only creates rows referencing the new,
  invisible flight row.
- `FlightEntity.availableSeats` removed. Reads count it with a correlated subquery inside the same
  query (`findPage`: one query for the page, plus the total count and the airport codes as before);
  a flight with no AVAILABLE seat reads `0`, never disappears. Pulled forward from Step 5 because
  the column is gone; Step 5 still owns EXPLAIN, the sold-out list test and the seat map.
- Create response still returns `availableSeats` (= aircraft seat count, what a read counts right
  after commit). Garbled comment in `create-flight.ts` fixed.
- Fixtures: integration aircraft now carry the `TEST_AIRCRAFT` layouts (120 / 5 seats);
  `makeFlight()` defaults `availableSeats` to its aircraft's seat count.

Checkpoint (integration, real Postgres):
- 176-seat aircraft (8 BUSINESS + 168 ECONOMY) → response `availableSeats: 176`; `flight_seats`
  BUSINESS 8 / ECONOMY 168, all AVAILABLE with no booking.
- Seat insert forced to fail (test-only trigger) inside CreateFlight → 0 flights, 0 seats, 0 audit,
  0 outbox; outside any transaction → 0 flights, 0 seats.
- Layout copied position by position (`EXCEPT` both ways = 0).

Counts after Step 3: unit 309/309; integration 92 (88 + 4 new) — 64 pass, 28 fail, all on the
booking side still using the dropped counter (replaced in Step 4).

## Step 4 — Allocate and release seats

- Port: `reserveSeat(flightId, bookingId, now)` → `reserved` **with `seat`** ("1A") | `sold-out` |
  `sales-closed` | `flight-not-found`. `releaseSeat` removed; `cancel()` releases the seat.
- Postgres `reserveSeat`: one statement — CTE picks the lowest AVAILABLE seat
  `FOR UPDATE OF seat SKIP LOCKED FOR SHARE OF flight` with BR-FLT-06 in its WHERE, then
  `UPDATE ... SET status='BOOKED', booking_id=$2 RETURNING row, letter`. 0 rows → the old
  follow-up read classifies flight-not-found / sales-closed / sold-out.
  `FOR SHARE OF flight` keeps what the counter UPDATE gave for free: the flight's status cannot
  change between the check and the claim; share locks don't block other bookings.
- Postgres `cancel`: one statement, two data-modifying CTEs — cancel the booking
  (`status='active'` + owner scope), release the seat `WHERE booking_id = cancelled.id`. A losing
  concurrent cancel matches no booking, so releases nothing.
- `CreateBooking` generates the booking id **before** `reserveSeat` (deferred FK, Decision 10):
  sold-out costs one statement and writes nothing.
- Discovered: outside a transaction the deferred FK is checked at the statement's own commit, so
  `reserveSeat` for a booking that never gets inserted fails (`FK_flight_seats_booking_id`) —
  pinned by an integration test. The contract subject therefore gained `transaction()`.
- `Booking.seat: string | null` (derived, read from `flight_seats`; null once cancelled). Needed
  because POST returned the seat but GET did not — `bookings.api.test` caught the inconsistency
  (it asserts GET equals the 201 body). Postgres reads add one query per page for the seats.
  `create()` ignores the field, like `FlightRepository.create()` ignores `availableSeats`.
- Audit `BOOKING_CREATED` metadata carries `seat`. `BookingCreatedEvent` unchanged (shared
  contract; no consumer needs it yet).
- Fake: the shared store holds seats per flight in (row, letter) order; `availableSeats` and
  `booking.seat` are counted/looked up on read. It generates `availableSeats` seats (no aircraft
  layouts); Postgres test seeding (`keepFirstSeats`) keeps the same first N, so both hand out
  the same codes.
- `loadFlightRows` now throws if a count is missing (was `?? 0`, which would show a bug as
  "sold out").
- ADR-004 addendum: why row locks + SKIP LOCKED are right for "one of many", OCC stays for
  one-row transitions; accepted edge (sold-out while the last seats' claimers roll back).

Contract tests (both tiers): allocation returns 1A, 1B, then sold-out; cancel makes the seat
allocatable again; a released front seat goes before free seats behind it; a second cancel
releases nothing; active booking reads its seat, cancelled reads null.

Counts after Step 4: unit 313 (309 − 1 releaseSeat + 1 cancel-releases + 3 contract + 1
create-booking order); integration 95 (92 + 3 contract) — 92 pass, 3 fail: the old counter race
tests A–C, rewritten in Step 6.

## Step 5 — Derived `availableSeats` on read + public seat map

- `GET /api/flights` / `GET /api/flights/:id`: `availableSeats` is a correlated scalar subquery
  (`SELECT count(*) ... WHERE flight_id = flight.id AND status = 'AVAILABLE'`) in the same
  SELECT as the page — one query per page, not one per flight. A scalar subquery always yields a
  row, so a sold-out (or seatless) flight shows 0 instead of vanishing; the `INNER JOIN ... GROUP
  BY` trap would drop it. Pinned on Postgres: a page with a sold-out flight (1 seat, booked) and a
  seatless one (0 seats) lists all three with 0, 0, 120.
- Port: `FlightRepository.findSeats(flightId)` → `FlightSeat[]` (position, fare class, status) or
  `undefined` for no flight (`[]` = a flight with no seats). Postgres: `flights LEFT JOIN
  flight_seats` in one query; `booking_id` is never selected — the type cannot carry it.
- `GET /api/flights/:id/seats` — public, like the flight itself (no owner data in it).
  Response `{ flightId, rows: [{ row, seats: [{ code, fareClass, status }] }] }`. Malformed or
  unknown id → 404 `FLIGHT_NOT_FOUND` (malformed never reaches the repository). Use case
  `createGetFlightSeatMap` groups the ordered seats into rows (rows can differ in width).
- ✅ Checkpoint: the HTTP test books a seat, then walks **every key at every depth** of the seat
  map and compares the set to an allow-list `{code, fareClass, flightId, row, rows, seats,
  status}`; also asserts the body contains neither the booking id, the passenger name nor the
  owner's id. A field added later fails the test even if nobody thought to forbid it.

### ⏸ EXPLAIN of the list query (2000 flights × 176 seats = 352 000 seat rows, 240 000 AVAILABLE)

Query captured with a TypeORM query logger (exactly what `findPage` sends), data committed and
`VACUUM ANALYZE`d, then `EXPLAIN (ANALYZE, BUFFERS)`; data deleted afterwards.

| Case | Seat lookup plan | Buffers | Time |
| --- | --- | --- | --- |
| page 1 (`OFFSET 0`) | Index Only Scan on `idx_flight_seats_available`, Heap Fetches 0, 20 loops | 107 | 1.4 ms |
| last page (`OFFSET 1980`) | same, but **2000 loops** | 6 855 | 51.7 ms |
| page 1, partial index dropped | Bitmap Heap Scan on `PK_flight_seats`, filter drops 56/176 rows, 20 loops | 3 627 | 3.7 ms |

- Yes, the Step 2 partial index is used, as an index-only scan: it holds only AVAILABLE rows and
  already contains `flight_id`, so counting never touches the table (0 heap fetches). Without it
  Postgres reads every seat's heap page and filters — ~50× the buffers.
- Cost recorded: the subquery runs once per **output row of the Sort**, and OFFSET rows are
  output rows. The last page computes 2000 counts to show 20 — cost grows with the offset.
  Fix when it matters (not done): order + LIMIT/OFFSET in an inner query, count in the outer one,
  so only the 20 shown flights are counted. Also pre-existing: no index on
  `(departure_at, id)`, so every page is Seq Scan + Sort of all flights.
- Index-only scans depend on the visibility map: right after heavy booking churn (before
  autovacuum) "Heap Fetches" rises. Seen here only because the data was VACUUMed first.

Counts after Step 5: unit 321 (313 + 3 seat-map HTTP + 2 FlightRepository contract + 3
`get-flight-seat-map`); integration 99 (95 + 2 contract + 2 Postgres: sold-out list, BOOKED in
`findSeats`) — 96 pass, 3 fail: still only the old race tests A–C (Step 6).

## Step 6 — Race tests, e2e, docs

`postgres-booking-race.integration.test.ts` rewritten on seats, through the real CreateBooking /
CancelBooking use cases (pool max 10). Every test ends with the same table check: active bookings
= BOOKED seats = seats joined to an active booking.

| Test | Scenario | Result (10 runs in a row, all green) |
| --- | --- | --- |
| A | 5 seats, 20 concurrent bookings | 5 created / 15 sold-out, seats exactly 1A–1E, 5 BOOKED / 0 AVAILABLE |
| B | 50 seats, 20 concurrent | 20 created / 0 sold-out, 20 distinct seats, 30 AVAILABLE |
| C1 | B without `SKIP LOCKED` (control repo, test-only) | **20 created / 0 sold-out every run** (63–115 ms vs B's 57–74 ms) |
| C2 | one open claim on 1A, then the next claim | without `SKIP LOCKED`: `lock_timeout` (55P03); with it: `1B` at once |
| D | full 5-seat flight, `[cancel X, new booking]` × 20 rounds, start staggered 0–8 ms | consistent every round; rebooked 8–11, sold-out 9–12 per run |
| E | 10 concurrent cancels of one booking | 1 cancelled / 9 already-cancelled, seat released once |

**Finding — the brief's control prediction was wrong on Postgres.** Expected: without
`SKIP LOCKED`, waiters on `1A` find it BOOKED after the wait and report sold-out although seats are
free. Observed: 0 false sold-outs. `EXPLAIN` of the claim shows `Limit → LockRows → Sort`:
`LockRows` is *under* `Limit`, so a row that fails the READ COMMITTED re-check is dropped and the
next row of the sort is tried — the waiter walks 1A, 1B, ... waiting on each. The real cost is a
queue (C2 pins it deterministically), not wrong answers. The false refusal belongs to the
*OCC* version (separate pick + conditional `UPDATE`), which was never built. ADR-004 addendum and
the adapter comment corrected; the accepted edge is restated: `SKIP LOCKED` can say sold-out while
the last seats' claimers roll back, waiting would not — and is still the worse trade.

Test D's first version (no stagger) gave 20/20 sold-out: the newcomer's claim always ran while the
cancel held the seat row, so only one order was exercised. Staggering covers both.

**Unrelated flake fixed:** `findUnpublished's query uses the idx_outbox_unpublished partial index`
started failing after the race runs — autovacuum had analyzed `outbox` with thousands of rows, then
TRUNCATE left it empty, and on a tiny table Seq Scan is the cheaper plan. The test now sets
`enable_seqscan = off` locally: it asserts the index *can* serve the query, not a cost decision.

### Proof the tests bite (each mutation reverted; `src` diff clean afterwards)

```text
M1 reserveSeat without SKIP LOCKED          → C2 fails (A, B still pass — C1 explains why)
M2 reserveSeat without any row lock         → A, B, C2, D fail (double allocation)
M3 cancel without the "released" CTE        → 4 booking contract cases (Postgres), D, E fail
M4 findSeats with JOIN instead of LEFT JOIN → "findPage keeps a sold-out flight ... seatless" fails
```

### End-to-end (docker compose: app rebuilt, notifier; identity dev process)

```text
Seed re-run first (integration tests TRUNCATE booking_db). e2e47-admin (promoted), e2e47-user.
1. POST VN471 on VN-A321 → 201, availableSeats 176; GET → 176                         ✅
2. GET /seats, no token → 200, 30 rows, 176 AVAILABLE (BUSINESS 8, ECONOMY 168);
   keys at any depth = code, fareClass, flightId, row, rows, seats, status            ✅
3. open, book → 201 seat 1A; map 1A BOOKED; availableSeats 175; GET booking seat 1A   ✅
4. DELETE → 204; map 1A AVAILABLE; availableSeats 176; GET booking cancelled, seat null ✅
5. VN472 on VN-B210 trimmed to 50 seats in psql, 20 concurrent HTTP bookings
   → 20×201, 20 distinct seats, availableSeats 30                                      ✅
6. psql, every flight: active bookings = BOOKED seats = paired (VN471 0/0/0,
   VN472 20/20/20); mismatched flights 0                                              ✅
Outbox: 21 booking-created + 1 booking-cancelled + 2 flight-created, all published;
flight-notifier booking_created_consumed ×21.
Postman folder "Day 47 — Seat inventory" via newman: 11 requests, 18 assertions, 0 failed.
```

Docs: README (new "Seat inventory and seat map" section, audit metadata, limitations: system picks
the seat, deep-OFFSET cost, event has no seat), `domain-model.md` (Decision 3 done, BR-SEAT-01/03 ✅,
Gap row), ADR-004 addendum (measured control), Postman folder + `postman/README.md`.

## Test count reconciliation

```text
Unit (api): 309 (Day 46) → 321 (+12)
  Step 3  ±0 (fixtures/fakes only)                                  → 309
  Step 4  −1 releaseSeat, +1 cancel-releases, +3 booking contract,
          +1 create-booking claim order                       +4    → 313
  Step 5  +3 seat-map HTTP, +2 flight contract, +3 get-flight-seat-map +8 → 321
Integration: 88 (Day 46) → 102 (+14)
  Step 3  +4 (layout copy, seat-insert failure ×2, 176-seat)         → 92
  Step 4  +3 booking contract on Postgres                            → 95
  Step 5  +2 flight contract, +2 Postgres (sold-out list, BOOKED)    → 99
  Step 6  race file: −3 (old A–C on the counter) +6 (A, B, C1, C2, D, E) → 102
flight-notifier 6, identity 12: unchanged.
```

## Not today

```text
HELD + 15-minute expiry, multi-passenger all-or-nothing holds, seat choice (step 5).
Per-fare-class availability in the API (only a total today).
booking-created carrying the seat code.
Deep-OFFSET cost of the counted list (count after paging) and an index on (departure_at, id).
```

## Reflection

- A denormalized counter is a second copy of the truth; deriving it moved the cost to reads, and
  EXPLAIN — not intuition — showed where that cost lands (index-only scan, but per OFFSET row).
- Concurrency claims need a control that can fail. The control here falsified the prediction and
  pointed at the real trade-off (queueing), which is what the ADR now records.
- A test that only checks expected keys passes when a sensitive field is added; an allow-list of
  every key at every depth does not.

# Day 48A — Multi-passenger booking, booking reference, all-or-nothing hold (phase D, step 5 part 1)

> ✅ Complete. Unit 351/351, integration 122/122, flight-notifier 8/8, identity 12/12, typecheck
> clean; hold race file 10× in a row; e2e on docker compose (HTTP + psql + notifier logs);
> Postman folders Day 47 and Day 48A via newman.

## Step 0 — Day 47 leftovers closed

### 1. Controls C1/C2 written down, the no-lock variant measured (C3)

Definitions added to `DAY-47.md`. New control **C3** in
`postgres-booking-race.integration.test.ts`: the pick is a plain snapshot read
(`LIMIT 1` subquery, no `FOR UPDATE`), the outer `UPDATE` re-checks
`status = 'AVAILABLE'` — the optimistic version Day 47 described but never built.

| Run (50 seats, 20 concurrent) | created | false sold-out |
| --- | --- | --- |
| 10 runs | 4–5 | **15–16** |

Never a double booking (the table check holds every run). Every caller read the same
lowest seat; after the first commit the others re-check a `BOOKED` row, match nothing and
answer sold-out. Side by side with Day 47:

```text
FOR UPDATE SKIP LOCKED (real)  20 created, 0 sold-out, no queue
FOR UPDATE (C1)                20 created, 0 sold-out, but a lock queue (C2)
no row lock, OCC (C3)          ~5 created, ~15 false sold-out
```

The test asserts `soldOut > 0` (not an exact number), so the control can fail.

### 2. ListBookings query count

New integration test in `postgres-booking-repository.integration.test.ts`: a second
DataSource with a counting TypeORM logger reads a page of 1 and a page of 10 bookings.

```text
page of 1  → 3 queries (count, page, one seat lookup for the page)
page of 10 → 3 queries
Mutation: seat lookup per booking → page of 10 = 12 queries, test fails. Reverted.
```

Integration after Step 0: 102 → 104 (+C3, +query count), all green.

## Step 1 — Decisions (Decision 11 in `docs/product/domain-model.md`)

1. Legacy `active` → `CONFIRMED`, `cancelled` → `CANCELLED`: "active" meant confirmed (no
   hold, no payment existed); mapping to `HELD` would let 48B's job expire them.
2. Link stays on `flight_seats.booking_id` (now shared by 1–9 seats; UQ dropped, plain index
   added). `booking_passengers` keeps a display copy of each seat, unique per booking.
3. One `name` per passenger; ≤ 9 passengers checked first, before any per-passenger work or
   query. New BR-BOOK-09: all passengers name a seat, or none does.
4. Gap before payment accepted (step 6 follows directly); no "confirm without paying"
   endpoint — a shortcut that reaches production the day its guard is forgotten.
5. Event: new `booking-held`; `booking-created` kept only for old messages.

Also updated: entity table (`BookingPassenger`), Decision 10 notes, FlightSeat/Booking
"reachable from Day 48A", gap rows, BR-BOOK-09; scope.md US-BOOK-01 gains the auto/mixed
criterion. Field name follows the domain model: `holdExpiresAt` / `hold_expires_at`.

## Step 2 — Five migrations on shaped dev data

```text
1790476000000 MoveBookingsToLifecycle   active→CONFIRMED, cancelled→CANCELLED; CHECK HELD/
                                         CONFIRMED/CANCELLED/EXPIRED; hold_expires_at +
                                         CHK_bookings_hold_expiry (required while HELD)
1790479600000 AddBookingReference       UQ first, backfill in a DO loop (bytes 0–5 of
                                         gen_random_uuid() % 32, redraw if taken), NOT NULL,
                                         CHK_bookings_reference_format
1790483200000 CreateBookingPassengers   table + backfill: passenger 1 = passenger_name,
                                         seat copy from flight_seats (LEFT JOIN)
1790486800000 ContractBookingPassengers reconcile, then drop passenger_name
1790490400000 AllowHeldSeats            CHECK + HELD; drop UQ_flight_seats_booking_id;
                                         partial idx_flight_seats_booking_id
```

No intermediate "old + new values" CHECK in migration 1: drop, UPDATE and new CHECK share one
transaction, so no writer sees a mixed table. A zero-downtime deploy would need the wide CHECK
as its own release; written in the migration.

**Shaped data** (Day 47 schema, after `seed:reference`):

| Flight | Booking | Status | Seat | Intent |
| --- | --- | --- | --- | --- |
| VN801 (VN-B210) | Alice Nguyen | active | 1A | consistent |
| VN801 | Bob Tran | active | 1C | consistent |
| VN801 | Carol Le | cancelled | — | consistent (seat released) |
| VN802 (VN-A321) | Dave Pham | active | — | broken: active, no seat |
| VN802 | Eve Vo | cancelled | 2A | broken: cancelled, still holds a seat |

**Run 1:** migrations 1–3 applied; 4 refused, listing exactly the two broken ones:

```text
booking QZT4EM (…) CONFIRMED on VN802: 0 BOOKED seat(s), 1 passenger(s), 0 matching
booking XKHJET (…) CANCELLED on VN802 still holds seat 2A
```

State in between: statuses mapped, references valid, one passenger each with its seat copy.
**Human decisions (per HINT):** cancel Dave's booking; release Eve's seat.
**Run 2:** 4 and 5 applied.

Reconciliation after: CONFIRMED bookings 2 = BOOKED seats 2 = their passengers 2 = matching
seat copies 2; seats held by a non-CONFIRMED booking 0. `bookings` has no `passenger_name`.
(Eve's passenger row keeps the copy `2A`, written before the seat was released by hand: a
display copy of a cancelled booking, not inventory.)

**Constraint probes** (each rolled back):

```text
HELD without hold_expires_at        → CHK_bookings_hold_expiry
HELD with hold_expires_at           → OK
status 'active'                     → CHK_bookings_status
reference 'ABCDEO' (letter O)       → CHK_bookings_reference_format
duplicate reference                 → UQ_bookings_reference
one booking on two seats            → OK (UQ dropped on purpose)
HELD seat without booking           → CHK_flight_seats_booking
same seat twice in one booking      → UQ_booking_passengers_seat
passenger position 10               → CHK_booking_passengers_position
blank passenger name                → CHK_booking_passengers_name
seat row without letter             → CHK_booking_passengers_seat
release by booking_id               → Index Scan idx_flight_seats_booking_id (enable_seqscan
                                      off; on 244 rows the planner prefers a Seq Scan)
```

**Down:** all five reverted (scratch script calling `undoLastMigration`): schema back to Day 47
(`active`/`cancelled`, `passenger_name` restored from passenger 1, UQ restored), then
re-applied — new references generated, same passengers.

**⏸ Does the order matter?** Yes:
- 3 before 5: the passenger backfill's `LEFT JOIN flight_seats` relies on
  `UQ_flight_seats_booking_id` (one seat per booking). Dropped first, a booking with two seats
  would produce two "passenger 1" rows (stopped by `UQ_booking_passengers_position`, but only
  by luck of a second constraint).
- 4 after 3: the contract drops `passenger_name`, the only source of the names.
- 1 before any code writes `HELD`: `CHK_bookings_hold_expiry` must exist first; and a seat
  `HELD` (5) for a booking whose status CHECK still says `active`/`cancelled` would describe a
  state the bookings table cannot express.

**Tests after Step 2:** typecheck 0/0, unit 321/321 (fakes do not see the schema).
Integration 104: 71 pass, 33 fail — all booking-side, the adapter still writes
`passenger_name` (27×) / reads it (3×), plus 3 `deadlock detected` in the race file whose
cause is not verified yet — to re-check once the adapter is replaced (Step 4).

## Step 3 — Booking reference, and the booking on the new schema

- `src/bookings/booking-reference.ts`: `BOOKING_REFERENCE_ALPHABET` (32 chars),
  `generateBookingReference(randomInt = crypto.randomInt)`, `isBookingReference`.
- Port: `Booking` = `{ id, reference, flightId, ownerAccountId, passengers: [{ name, seat }],
  createdAt, status: HELD|CONFIRMED|CANCELLED|EXPIRED, holdExpiresAt }`;
  `create()` → `created | reference-taken`; new `findByReference(reference, scope)`.
- Postgres `create()`: `INSERT … ON CONFLICT ON CONSTRAINT "UQ_bookings_reference" DO NOTHING
  RETURNING id` — only the reference constraint, so a duplicate id or a bad FK still raises —
  then the passengers in one multi-row insert; atomic on its own (joins the outer transaction
  or opens one). Reads load the passengers of a whole page in one query.
- Use case: `createWithFreeReference` draws up to `MAX_REFERENCE_ATTEMPTS` (5) references,
  then throws `BookingReferenceExhaustedError` (a system error, not an outcome). The booking is
  `HELD` with `holdExpiresAt = now + HOLD_DURATION_MS` (15 min, BR-BOOK-04).
- Pulled forward because the schema changed under them: entities (`BookingEntity` + new
  `BookingPassengerEntity`), `reserveSeat` now writes `HELD` (still one seat; `holdSeats`
  replaces it in Step 4), `cancel()` moves `HELD|CONFIRMED → CANCELLED`, `FlightSeatStatus`
  gains `HELD`, the seat map shows `HELD`. Request body and event unchanged until Step 5
  (`passengerName` in, `booking-created` out).
- Fixtures: `tests/fixtures/bookings.ts` (`makeBooking`, `nextBookingReference` — a counter
  written in the alphabet, so fixture references never collide by accident).

**⏸ Retry and the seats already held.** With `ON CONFLICT DO NOTHING` the clash is not an
error: the transaction stays healthy, the seat claimed before `create()` stays held, and the
next draw inserts in the same transaction. Catching `23505` instead: the transaction is
already aborted, every later statement fails ("current transaction is aborted"), `COMMIT`
becomes `ROLLBACK` — the seat is released only because everything is thrown away, and the
client gets a 500 for a 1-in-a-billion clash.

**✅ Checkpoint (Postgres, through the use case):** a first booking takes `AAAAAA`; the second
draws `AAAAAA` (taken), then `BBBBBB` → created as `BBBBBB`, passenger Bob on `1B`, seat
`HELD` for it; 2 audit rows, 2 outbox rows.

**Mutations (reverted):**

```text
M1 plain INSERT, no ON CONFLICT   → exactly 2 fail, both 23505: contract "reference-taken …
                                    the transaction goes on" (Postgres) and the checkpoint
M2 findByReference without scope  → contract "findByReference … another account's reference
                                    is hidden" fails
```

(A first M1 run listed unrelated failures too: two integration files run without
`--test-concurrency=1` truncate the same database under each other. Re-run sequentially.)

**Tests:** unit 321 → 330 (+4 booking-reference, +2 create-booking retry/exhausted, +3 booking
contract: read-back split into "as written" + "cancelled keeps the copy", reference-taken,
findByReference). Integration 104 → 108 (+3 contract on Postgres, +1 checkpoint). The 3
deadlocks seen after Step 2 are gone once the adapter matches the schema; their exact cause
was not investigated further (watch for them again in the Step 6 race runs).

## Step 4 — All-or-nothing holds (`holdSeats` replaces `reserveSeat`)

- Port: `holdSeats(flightId, bookingId, request, now)`, `request` = `{ kind: "auto", count }`
  | `{ kind: "chosen", seats }`. Outcomes: `held { seats }` (auto: row/letter order; chosen:
  the request's order) | `not-enough-seats` | `seats-unavailable { seats }` |
  `unknown-seats { seats }` | `sales-closed` | `flight-not-found`. Every outcome but `held`
  wrote nothing.
- **Auto** (one statement): CTE `candidates` (`ORDER BY row, letter LIMIT $n FOR UPDATE OF
  seat SKIP LOCKED FOR SHARE OF flight` + sales window) → `enough` (`count(*) = $n`) →
  `UPDATE … WHERE enough.ok`. Fewer candidates → the UPDATE matches nothing. RETURNING has
  no order, so the codes are sorted before they are paired with passengers.
- **Chosen** (one statement): `requested` (unnest of rows/letters) → `locked` (`ORDER BY row,
  letter FOR UPDATE OF seat FOR SHARE OF flight`, **no** SKIP LOCKED: a locked seat the
  customer chose is waited for, then re-read) → `verdict` (`count = n AND
  bool_and(status = 'AVAILABLE')`) → `held` (UPDATE only if `verdict.ok`) → final SELECT of
  every locked row with its status. TypeScript then names `unknown-seats` (requested, no row)
  before `seats-unavailable` (row not AVAILABLE) — positions only, never who holds them.
  Lock order: the sort is inside the locking query, so rows are locked in (row, letter)
  order whatever the request order (proved by race test B in Step 6).
- No rows at all → one follow-up read classifies `flight-not-found` / `sales-closed` /
  (auto) `not-enough-seats` / (chosen) all `unknown-seats`.
- Fake: same check order (flight, sales window, unknown, unavailable), writes only when
  everything passes.
- Use case: `holdSeats(…, { kind: "auto", count: 1 })` until Step 5 brings the
  multi-passenger body; every non-`held` outcome passes through.
- Pulled forward from Step 5 so the route compiles: `NOT_ENOUGH_SEATS` (409, replaces
  `FLIGHT_SOLD_OUT`), `SEATS_UNAVAILABLE` (409, seat codes in `details`), `UNKNOWN_SEAT`
  (422).

**Contract (both tiers), +7:** auto 3 takes the 3 lowest free seats in order; auto 3 with
2 left → `not-enough-seats` and **no seat changes**; chosen held exactly, request order;
chosen with one taken → `seats-unavailable` naming only that one, the other stays
`AVAILABLE`; unknown positions → `unknown-seats`, nothing held; chosen on a closed flight →
`sales-closed` even with unknown seats; cancel releases every seat of a 3-seat booking.
The contract subject gained `seats(flightId)` (read past the port) so "nothing was written"
is checked on both sides.

**🐞 Half-commit test (Postgres):** `holdSeats(auto 3)` on a 2-seat flight inside a
transaction that **commits** → `not-enough-seats`, 0 seats HELD, 0 seats pointing at no
booking.

**Mutations (reverted):**

```text
M1 auto without enough.ok              → contract "auto 3 with 2 left … changes no seat"
                                          (Postgres) + the half-commit test fail
M2 chosen without bool_and(AVAILABLE)  → contract "seats-unavailable names only that one" fails
```

Finding from M1: the half-commit does not end in silent orphans here — the two seats point
at a booking id that is never inserted, so the **deferred FK** (Decision 10) rejects the
COMMIT (`FK_flight_seats_booking_id`). The schema is a second net, but it would turn a
409 into a 500; the statement itself must refuse.

**Tests:** unit 330 → 337 (+7 contract on the fake). Integration 108 → 116 (+7 contract on
Postgres, +1 half-commit). (Postgres had stopped again — exit 255 under WSL — and was
restarted with `docker compose start`, no `-v`.)

## Step 5 — Use case, route, event

**Body:** `{ passengers: [{ name, seat? }] }`. `validateCreateBookingInput` returns
`{ seatSelection: "auto", passengers: [{ name }] } | { seatSelection: "chosen", passengers:
[{ name, seat: SeatPosition }] }` — BR-BOOK-09 as a type, so the use case cannot receive a
mix. Order of checks:

1. not an object → `INVALID_BODY`;
2. `passengerName` present → `UNSUPPORTED_FIELD` (names what replaced it; collected, not
   returned early);
3. not an array of 1–9 → `INVALID_PASSENGER_COUNT`, returned **before** any passenger is
   read (10 empty objects give exactly one issue);
4. each passenger → `INVALID_PASSENGER` / `REQUIRED` (name) / `INVALID_SEAT` (`parseSeatPosition`;
   absent means "pick for me", anything present must be a code);
5. some seats named, some not → `MIXED_SEAT_SELECTION`;
6. a seat repeated → `DUPLICATE_SEAT` on each later repeat (BR-BOOK-02).

**CreateBooking:** auto → `holdSeats({ kind: "auto", count: n })`, chosen →
`{ kind: "chosen", seats }` in request order. Held seats are paired with passengers by
index; a count mismatch throws (a broken adapter, not an outcome). Audit metadata:
`reference`, `passengerCount`, `seats` (`"1A,1B"` — `AuditMetadata` is flat),
`holdExpiresAt`; no passenger names.

**Event `booking-held`** (`packages/contracts/src/booking-held-event.ts`, dist rebuilt):
`{ booking: { id, reference, flightId, createdAt, holdExpiresAt, passengers: [{ name, seat }] } }`.
No `status` field — the event type already says HELD. `booking-created` is no longer
produced; its contract stays, marked as kept for old messages. Notifier: new
`booking-held` consumer (logs reference, passenger count, `holdExpiresAt` — not names);
the `booking-created` consumer still subscribes.

**Routes:** `GET /api/bookings/by-reference/:reference` (`GetBookingByReference`:
malformed → not-found without a query; another account's → the same 404 body as a missing
one). Cancel needed no code change — the repository already moves `HELD|CONFIRMED`; only
its doc comment changed.

**Postgres checkpoint:** 3 passengers on `1F, 1A, 1C` through the real use case → each
`booking_passengers` row's seat copy joins to the `flight_seats` row `HELD` for the
booking, in position order; the outbox row is `booking-held` with the same passengers.

**Mutations (reverted):**

```text
M1 pair seats in reverse order          → 4 unit + 1 integration fail (auto order,
                                           chosen pairing, event payload, Postgres copy)
M2 validate passengers before the count → the body-shape HTTP test fails
                                           (10 × {} gives 11 issues, not 1)
```

**Tests:** unit 337 → 351 (+7 HTTP: auto order, chosen pairing, `SEATS_UNAVAILABLE` naming
one seat, `NOT_ENOUGH_SEATS` holding nothing, `UNKNOWN_SEAT`, body shapes, by-reference;
+3 use case: chosen request, validation never reaches the repository, seat-count mismatch
throws; +4 `get-booking-by-reference`). Integration 116 → 117 (+1 checkpoint). Notifier
6 → 8. Identity 12.

## Step 6 — Race tests, e2e, docs

New file `postgres-booking-hold-race.integration.test.ts` (real CreateBooking, pool max 10).
Every test ends on the same table check: HELD seats = passengers of HELD bookings, no HELD seat
outside a HELD booking, every passenger's seat copy joins a seat HELD for that booking.

| Test | Scenario | Result (10 runs in a row, all green) |
| --- | --- | --- |
| A | 4 seats, two 3-passenger auto holds, 20 rounds | ≤ 1 created asserted; measured **1 created every round (200/200)**, never both, never partial |
| B | `[12A, 12B]` vs `[12B, 12A]`, 20 rounds | 1 created / 1 `seats-unavailable` every round, **no `40P01`** |
| C | control: seat-by-seat locks in request order + barrier after the first lock, 10 rounds | `40P01` **10/10**, exactly one victim, the other created |
| C (measured) | same control, no barrier | **98/100** rounds deadlocked (one-off run); the suite keeps 20 rounds (19–20 each run), since each deadlock costs `deadlock_timeout` = 1 s |
| D | 10 concurrent callers, each draws `K7Q4PZ` first | 10 created, 10 distinct references, exactly one `K7Q4PZ` |

Test A's open question: with `SKIP LOCKED`, two multi-seat picks could each lock some of the last
seats and skip the other's, so both see too few → both `NOT_ENOUGH_SEATS`. Not observed in 200
rounds; recorded as a diagnostic, listed in README limitations, explained in the ADR-004 addendum.

**Mutations (reverted, `grep MUTATION` = 0):**

```text
M1 locked without ORDER BY              → SURVIVES (Test B green 3/3). EXPLAIN: the planner
                                           dedupes the IN list with Unique over Sort (row,
                                           letter), so locks still follow that order — by
                                           accident of the plan.
M2 locked ORDER BY request position     → Test B fails at once: 40P01 between two single
                                           statements.
```

The survivor became a comment in `holdChosenSeats` and a paragraph in the ADR: the `ORDER BY` is
the guarantee, the plan is not.

### End-to-end (docker compose: app + notifier rebuilt; identity dev process)

```text
Seed re-run first (integration tests TRUNCATE booking_db). e2e48-admin (promoted), e2e48-user,
e2e48-other. VN485 / VN486 on VN-B210 (68 seats, rows of ACDF).
1. auto, 3 passengers → 201 HELD, reference TJFVG4, holdExpiresAt = now + 15 min,
   seats 1A 1C 1D (row 1 has no B); map shows them HELD; availableSeats 65            ✅
2. chosen [10C,10D] → 201 paired; other user [10F,10D] → 409 SEATS_UNAVAILABLE naming 10D
   only, 10F still AVAILABLE; [99K] → 422 UNKNOWN_SEAT                                  ✅
3. 10 passengers → one INVALID_PASSENGER_COUNT; mixed → MIXED_SEAT_SELECTION; duplicate
   → DUPLICATE_SEAT; passengerName → UNSUPPORTED_FIELD (+ INVALID_PASSENGER_COUNT)      ✅
4. by-reference: owner 200, admin 200, other 404 with the same body as a missing one,
   malformed 404, no JWT 401                                                            ✅
5. DELETE the HELD booking → 204, again → 409; GET → CANCELLED with the seat copies;
   1A 1C 1D AVAILABLE                                                                   ✅
6. VN486 trimmed to 10 seats in psql, 10 concurrent 3-passenger HTTP bookings
   → 3×201, 7×409, availableSeats 1                                                     ✅
psql, both flights: HELD seats = HELD passengers (2/2, 9/9), orphaned 0.
Outbox: 5 booking-held + 1 booking-cancelled + 2 flight-created, all published;
flight-notifier booking_held_consumed per booking, no passenger name in its log.
Postman via newman: "Day 48A — Multi-passenger hold" 14 requests / 21 assertions / 0 failed;
"Day 47 — Seat inventory" (assertions updated to HELD / passengers[0].seat) 11 / 18 / 0.
```

First e2e run asked for `10E`, which VN-B210 does not have: the API answered
`422 UNKNOWN_SEAT` before `SEATS_UNAVAILABLE`, as designed; the script was fixed to `10F`.
The race tests' leftover outbox rows were relayed when the rebuilt app started — the first
proof that the container's notifier consumes `booking-held`.

**Docs:** README (booking body, new "Multi-passenger holds and booking references" section,
audit metadata, migrations table, messaging, limitations: no payment, no expiry job yet, no
per-passenger price, the `SKIP LOCKED` multi-seat edge), Postman (bodies of every booking
request, Day 47 assertions, new Day 48A folder, README), domain-model "Existing" column
(BR-SEAT-01/02, BR-BOOK-01/02/04/05/06/09), ADR-004 addendum (all-or-nothing + lock order),
learnings note `all-or-nothing-holds-and-lock-ordering.md`.

## Test count reconciliation

```text
Unit (api):   321 (Day 47) + 9 (Step 3: 4 reference, 3 contract on fake, 2 use case)
              + 7 (Step 4: contract on fake) + 14 (Step 5) = 351
Integration:  102 + 2 (Step 0: C3, query count) + 4 (Step 3: 3 contract, 1 retry checkpoint)
              + 8 (Step 4: 7 contract, 1 half-commit) + 1 (Step 5 checkpoint)
              + 5 (Step 6: A, B, C, C measured, D) = 122
Notifier:     6 + 2 = 8.   Identity: 12 (unchanged).
```

## Not today

- **Expiry job** (`HELD → EXPIRED` after 15 min, releasing seats) and the expiry-vs-cancel race:
  Day 48B. Until then a hold lasts until its booking is cancelled.
- **Payment / `CONFIRMED`**: phase D step 6. No shortcut confirm route (Decision 11).
- **BR-BOOK-03** price per passenger from the fare class, booking total.
- `BookingCreatedEvent` contract and the `booking-created` consumer can be removed once its
  queue and DLQ are empty (message contract step).
- The `SKIP LOCKED` multi-seat edge (both racing holds fail) — measured 0/200, accepted.

## DAY 48A SUMMARY

A booking is now 1–9 passengers with a 6-character reference, `HELD` for 15 minutes on seats
held all-or-nothing in one statement. Five migrations moved the old data (status lifecycle,
reference backfill, passengers table expand → backfill → contract with a refusing
reconciliation, `HELD` seats). The two multi-row hazards were each proven by a test that fails
without the fix: the half-commit (verdict inside the `UPDATE`) and the deadlock (global
(row, letter) lock order — and a surviving mutation showed the `ORDER BY`, not the plan, is the
guarantee). New `booking-held` event and consumer; lookup by reference with the same
ownership rule as by id.

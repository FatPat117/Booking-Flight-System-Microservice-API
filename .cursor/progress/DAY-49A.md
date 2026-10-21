# Day 49A — Fares: `Money`, price per fare class, price snapshot at hold time (phase D, step 6a)

> ✅ Complete (2026-10-21). Unit 400/400, integration 152/152, notifier 14/14, identity 12/12;
> typecheck clean; fare race file 10× in a row; e2e on docker compose (HTTP + psql + app and
> notifier logs, 6 scenarios); Postman Day 49A folder + Days 46/47/48A/48B(1) via newman, 0 failures.

## What and why

Payment (Day 49B) must charge an amount that is fixed when the seats are held, and there was none:
a flight had one `price_in_cents` (VND *or* USD, holding whole đồng despite its name) and a booking
stored no price. Today: a `Money` value object in whole đồng, one fare per fare class
(`flight_fares`) for exactly the classes the aircraft has (BR-FLT-09), and each passenger's fare
copied by the hold statement itself with the fare rows share-locked (BR-BOOK-03). The booking
total is derived from those prices. Phase D step 6 was split into 6a fares / 6b payment / 6c
payment failures.

## Decisions made with the student

| Question | Choice |
|---|---|
| Number type in the domain | `number` integer with a safe-range check; the adapter converts the `bigint` string and throws if out of range |
| Fare model | Table `flight_fares (flight_id, fare_class)`, `amount_vnd bigint > 0` |
| Booking total | Derived from the passengers' prices (never stored) |
| Bookings made before today | Backfilled at migration time, written down |
| A fare for a class the aircraft lacks | `422 FARE_CLASS_NOT_ON_AIRCRAFT` (classes priced = classes with seats) |
| `booking-held` | Add `fareClass`/`price` per passenger and `total`, optional in the parser |
| `flight-created` | Add `fares`; keep `priceInCents` (ECONOMY) + `currency: "VND"` as deprecated |
| Where prices are read | `fares` on GET flight, list, and once on the seat map; no "lowest price" (no story) |
| Added after Step 3 | `CHECK amount <= 2^53 − 1` on both price columns (refuse on write, not throw on read) |

## Step 0 — Day 48B leftovers + the new order

1. **Plan tests are deterministic without `ANALYZE`.** Both plan tests
   (`idx_bookings_held_expiry` in `postgres-booking-repository.integration.test.ts`,
   `idx_outbox_unpublished` in `postgres-outbox-repository.integration.test.ts`) run
   `SET LOCAL enable_seqscan = off` in their own transaction, so earlier tests' statistics
   cannot change the plan. Their comments now say what they assert — the index *can* serve the
   predicate and the order — and what they do not: that the planner picks it on real data (that
   was measured once with `EXPLAIN (ANALYZE)` on Day 48B, 104 vs 2 990 buffers, not pinned).
2. **English learnings are the primary source.** `docs/learnings/README.md` now says so; the
   Vietnamese README already called itself a summary of the English notes.
3. **Phase D step 6 split** into 6a fares (today), 6b simulated payment (49B), 6c payment
   failures (49C): domain-model "Phase D order" table and a Day 49A row in the roadmap history.
   Phase order unchanged, so no ADR (the roadmap's own rule).

## Step 1 — Decision 13 + BR-FLT-09

`docs/product/domain-model.md`:

- **Decision 13** with a reason for each choice: a `flight_fares` row per class; BR-FLT-09
  kept by the application (no declarative constraint can say "a row exists for every class");
  `amount` in whole đồng, `bigint` column, `number` in TypeScript with a loud range check; the
  price copied inside the hold statement with the fare rows `FOR SHARE`; `Booking.total`
  derived; legacy bookings priced at migration time; no exchange rate in code; additive event
  fields with deprecated `priceInCents`.
- **BR-FLT-09** added (Existing: — until Step 4).
- Entities: `Money.amount` (was `amountMinor`), `Flight.fares` optional per class,
  `Booking.total` derived; Flight aggregate lists BR-FLT-09; Decision 5 and the gap table point
  to Decision 13. `docs/learnings/domain-model-and-aggregates.md` example renamed to `amount`.

## Step 2 — `Money` value object

- `api/src/money/money.ts`: `Money = { amount, currency: "VND" }`; `vnd()` (throws on negative,
  fractional, non-finite or unsafe), `isVndAmount` (for validation), `addMoney` (throws on a
  currency mismatch or a sum past 2^53 − 1), `sumMoney` (empty list = 0),
  `parseVndFromDatabase` (the `pg` `bigint` string → number; throws unless it is a plain whole
  number that is exact as a JS number).
- `tests/money.test.ts`: 8 tests. Unit 377 → 385.
- Mutation: parsing with plain `Number(value)` instead of the integer pattern turns `""` into
  0 đồng — the database-value test fails. Restored.

## Step 3 — Migrations

| # | Migration | What |
| --- | --- | --- |
| 1 | `1790497600000-CreateFlightFares` | `flight_fares (flight_id, fare_class)` PK, `amount_vnd bigint > 0`, FK, class `CHECK` |
| 2 | `1790501200000-BackfillFlightFares` | VND flight with ECONOMY seats → ECONOMY fare = `price_in_cents` unchanged (it was đồng). No BUSINESS, no USD guess |
| 3 | `1790504800000-ContractFlightFares` | Refuses (list + HINT) on BR-FLT-09 breaks, then drops `price_in_cents`, `currency` and their `CHECK`s. `down`: ECONOMY (or lowest) fare back into the column, lossy |
| 4 | `1790508400000-AddPassengerFareSnapshot` | `booking_passengers.fare_class`, `price_vnd bigint`; priced from the seat at its position on the flight and the fare **at migration time**; refuses a seat that cannot be priced; `CHECK`s: the three of seat/class/price NULL together, class, price > 0 |

Entities are not touched yet: dropping `FlightEntity.priceInCents` belongs with the repository
change (Step 4), the passenger columns with the hold (Step 5).

**Shaped data** (Day 48B schema, `seed:reference` aircraft):

| Flight | Aircraft | Old price | Bookings |
| --- | --- | --- | --- |
| VN901 | VN-B210 (economy only) | 1 500 000 VND | FAREAA CONFIRMED 1A, 1C · FAREBB CANCELLED, copy 2A (seat released) |
| VN902 | VN-A321 (BUSINESS rows 1–2) | 1 800 000 VND | FARECC HELD 1A (BUSINESS), 3A (ECONOMY) |
| VN903 | VN-A588 | 9 900 USD (cents) | — |

**Run 1:** 1–2 applied; 3 refused, listing exactly the two flights that cannot be priced:

```text
flight VN902 (…, old price 1800000 VND): 8 seat(s) in BUSINESS, no fare
flight VN903 (…, old price 9900 USD): 180 seat(s) in ECONOMY, no fare
```

**Human decisions (per HINT):** VN902 BUSINESS 4 200 000; VN903 ECONOMY 2 475 000 ($99 at a
rate chosen by a person, not by code). Plus, on purpose, a stray BUSINESS fare on the
economy-only VN901. **Run 2:** refused again, only `VN901: fare for BUSINESS, but no seat in that
class`. Deleted it. **Run 3:** 3 and 4 applied.

After: `flights` has no `price_in_cents`/`currency`; passengers priced from their seats —

```text
FAREAA CONFIRMED  1A ECONOMY 1500000 · 1C ECONOMY 1500000   total 3000000
FAREBB CANCELLED  2A ECONOMY 1500000 (seat released, priced by position)  total 1500000
FARECC HELD       1A BUSINESS 4200000 · 3A ECONOMY 1800000   total 6000000
```

**Down:** all four reverted with a scratch `undoLastMigration` script: `price_in_cents`/`currency`
back (VN903 now `2475000 VND`: the lossy direction, written in the migration), no
`flight_fares`, no passenger price columns. **Up again** with one passenger's seat copy broken
to 40A: 3 refused first (the BUSINESS fare was deleted by the down — set again), then 4 refused
with `booking FAREBB … passenger 1: seat 40A has no fare`. Fixed the copy, run → applied.

**Constraint probes** (each rolled back):

```text
passenger price NULL, class set                → CHK_booking_passengers_fare
passenger class + price NULL, seat set         → CHK_booking_passengers_fare
passenger seat + class + price all NULL        → OK (legacy, seat unknown)
passenger price 0                              → CHK_booking_passengers_price_positive
passenger class 'FIRST'                        → CHK_booking_passengers_fare_class
fare amount 0                                  → CHK_flight_fares_amount_positive
second ECONOMY fare on a flight                → PK_flight_fares
fare class 'PREMIUM'                           → CHK_flight_fares_fare_class
fare for an unknown flight                     → FK_flight_fares_flight_id
fare 9007199254740993 (2^53 + 1)               → accepted by bigint; the adapter refuses on read
```

**Tests:** typecheck clean; unit 385 green (fakes). Integration 34/140 — all 106 failures are the
same error, `column "price_in_cents" of relation "flights" does not exist`: the repository still
writes the dropped column. Expected between Step 3 and Step 4.

**Added after review:** `CHK_flight_fares_amount_safe` and `CHK_booking_passengers_price_safe`
(`<= 9007199254740991`): a larger amount would be stored and then make its flight or booking
unreadable (the adapter throws). Migrations reverted and re-applied on the empty dev schema;
probe: `9007199254740992` → `CHK_flight_fares_amount_safe`, `9007199254740991` → accepted.

## Step 4 — Flights have fares

- **Types:** `FlightFares = Partial<Record<FareClass, Money>>`; `Flight.fares` and
  `CreateFlightInput.fares` replace `priceInCents`/`currency`.
- **Request body:** `"fares": { "ECONOMY": 1500000, "BUSINESS": 4200000 }` — whole đồng per class,
  no currency (BR-MONEY-01). Responses carry `Money` objects (`{ amount, currency }`).
- **Validation:** `fares` required; `INVALID_FARES` (not an object), `INVALID_FARE_CLASS`,
  `INVALID_FARE` (not a positive safe integer — a `Money` object is rejected too);
  `priceInCents`/`currency` → `422 UNSUPPORTED_FIELD` (Day 46 `availableSeats` pattern).
- **CreateFlight:** BR-FLT-09 against `countSeatsByFareClass(aircraft.seats)` →
  `MISSING_FARE` / `FARE_CLASS_NOT_ON_AIRCRAFT`, reported with `UNKNOWN_AIRPORT`/`UNKNOWN_AIRCRAFT`.
  Audit `FLIGHT_CREATED` gains `fares: "ECONOMY:1500000,BUSINESS:4200000"`.
- **Repository:** one `INSERT … unnest` into `flight_fares` in the create transaction (after the
  seats); reads load every fare of a page in one query (`flight_id = ANY($1)`) and parse
  `amount_vnd` with `parseVndFromDatabase`. `FlightEntity` lost both columns.
- **Seat map:** `fares` once at the top (from `findById`), not per seat.
- **Event `flight-created`:** `fares` added (optional in the parser, validated when present);
  `priceInCents` (ECONOMY, else the lowest fare) and `currency: "VND"` still sent, `@deprecated`.
  Consumer logs `fares: "ECONOMY:1500000 VND,…"`.
- **Fixtures/fakes:** `makeSeats(count, businessRows)`, a two-class aircraft `VN-A350`
  (`ZZ-FX3` on Postgres: rows 1–2 BUSINESS, 3–5 ECONOMY), `FIXTURE_FARES`/`faresFor(seats)`,
  `makeFlight` prices exactly the aircraft's classes. The fake flight repository copies a
  fixture aircraft's layout (first `availableSeats` seats) instead of generating economy seats.

**Tests:** unit 385 → 395 (create-flight +2, flights API +2 and fare subtests 8 replacing 4
price/currency ones, flight contract +2 on the fake). Notifier 10 → 12. Integration 142
(flight contract +2): every flight test green; the 55 failures left are all
`CHK_booking_passengers_fare` — passengers are still inserted without a price, which is Step 5.

## Step 5 — The price is copied in the hold statement

- **Port:** `HoldSeatsResult.held.seats: HeldSeat[]` (`{ seat, fareClass, price }`);
  `BookingPassenger` gains `fareClass` and `price` (null exactly when `seat` is); `Booking.total`.
- **Hold SQL:** both statements gain the CTE `SHARE_LOCKED_FARES` (`flight_fares` of the flight,
  `FOR SHARE`) and join it — a plain-SELECT CTE runs only when read, so declaring it is not
  enough. Auto: the UPDATE moved into a `held` CTE returning `fare_class`; the final SELECT joins
  the fares. Chosen: `locked` carries `fare_class`, the final SELECT joins the fares; prices are
  paired to the request's order by seat code. A held seat without a fare throws (`toHeldSeat`) —
  BR-FLT-09 broken must not pass as `not-enough-seats` or as a free seat.
- **Writes/reads:** `insertBooking` stores `fare_class`, `price_vnd`; `mapPassenger` parses
  `price_vnd` with `parseVndFromDatabase`. `bookingTotal(passengers)` (`bookings/booking-total.ts`)
  is the one place the total is computed: CreateBooking, the adapter, the fixtures. ListBookings
  stays at 3 queries (prices live on the passenger rows; the existing test still passes).
- **CreateBooking:** passengers paired with their held seat's price; response `total`; audit
  `totalVnd`; `booking-held` gains `fareClass`/`price` per passenger and `total` (optional in the
  parser, validated when present). Notifier logs `total` + `currency`.
- **Fake:** prices from `flight.fares` by the seat's class; throws on a missing fare before
  writing anything.
- **Fixtures:** `passengersFor(heldSeats)`, `makeBooking` derives `total`; contract helpers
  `economy(...codes)` and `holdPriced`.

**Tests:** unit 395 → 400 (create-booking +2: prices per class + total + event + audit; a
missing fare throws and stores nothing; booking contract +2 on the fake; bookings API +1: price
and total identical on create, by id, by reference, in the list). Integration 142 → 144 (booking
contract +2 on Postgres: two-class chosen hold 4.2M + 1.5M + 4.2M = 9.9M; auto hold at
2^52 − 1 per seat reads back exact). Notifier 12 → 14. All green; typecheck clean.

## Step 6 — Race tests, e2e, docs

**`api/tests/integration/postgres-fare-snapshot.integration.test.ts`** (two-class fixture flight,
fares 4 200 000 / 1 500 000; real CreateBooking on separate pool connections):

| Test | Scenario | Result |
| --- | --- | --- |
| A | fare change after the hold | booking keeps 4.2M + 1.5M = 5.7M; next booking 5M + 2M = 7M; flight reads the new fares as numbers |
| A (missing fare) | BUSINESS fare deleted by hand | hold throws `no BUSINESS fare for seat 1A (BR-FLT-09)`; 0 seats taken, 0 bookings |
| B1 | gate: uncommitted fare change; hold [1A, 3A] | pending after 50 ms; after commit, new fares for both classes |
| B1 (auto) | same gate, system-picked hold of 2 | waits; 5M + 5M |
| B1 control | same chosen statement without `FOR SHARE` (test-only repository) | does not wait; old fares |
| B2 | hold's transaction kept open at the audit write; then a fare change | the change waits; booking commits first at the old fare |
| B2 control | without `FOR SHARE` | the change commits mid-hold; booking commits after it at the old fare |
| C | 20 rounds, two holds racing a change staggered 0–20 ms | never mixed; per run 32–38 old / 2–8 new of 40 |

**10 runs in a row:** 8/8 every run.

**Mutations** (each restored, `git diff` clean of them):

| Mutation | Caught by |
| --- | --- |
| `FOR SHARE` removed from `SHARE_LOCKED_FARES` | B1, B2 |
| chosen statement takes the price from a scalar subquery (CTE declared, never read) | B1, B2 |
| the same in the auto statement | B1 (auto) |
| missing-fare check disabled in `toHeldSeat` | A (missing fare) — added because no Postgres test covered the throw |
| `parseVndFromDatabase` ×100 | Money unit test + 8 integration tests |

**Found:** a plain-SELECT CTE that nothing reads is not executed — `FOR SHARE` in it takes no lock
while the price still comes out right. And C passes without the lock (one statement = one
snapshot), so it guards the statement's shape, not the lock; B1/B2 prove the lock.

**E2E** (docker compose: app + notifier rebuilt, identity `npm run dev`, seed, fresh accounts):

```text
2. VN-A321 with ECONOMY only            → 422 [fares.BUSINESS MISSING_FARE]
   old priceInCents + currency          → 422 [priceInCents UNSUPPORTED_FIELD, currency UNSUPPORTED_FIELD]
1. VN-A321 with both fares              → 201 fares {ECONOMY 1500000 VND, BUSINESS 4200000 VND}, no priceInCents/currency, 176 seats
   seat map                             → fares once; 1A BUSINESS, 3A ECONOMY
3. book [1A, 3A]                        → 6ERMGG: BUSINESS 4200000 + ECONOMY 1500000, total 5700000
4. psql UPDATE flight_fares → 5M / 2M   → 6ERMGG still 5700000 [4200000, 1500000]; new RBQK59 7000000 [5000000, 2000000]
   booking_passengers rows match; GET flight shows the new fares
5. notifier                             → flight_created_consumed fares "ECONOMY:1500000 VND,BUSINESS:4200000 VND";
                                          booking_held_consumed total 5700000 / 7000000 VND; all 4 DLQs 0
6. outbox flight-created                → priceInCents 1500000, currency "VND", fares {…} (deprecated fields only here);
                                          GET flight has neither field; flights table has no price_in_cents/currency;
                                          audit FLIGHT_CREATED fares "ECONOMY:1500000,BUSINESS:4200000", BOOKING_CREATED totalVnd 5700000
```

**Postman:** 13 bodies `priceInCents`/`currency` → `fares` (all on two-class aircraft, so both
classes); new folder **Day 49A — Fares** (8 requests: `MISSING_FARE`, `FARE_CLASS_NOT_ON_AIRCRAFT`
on VN-B210, `UNSUPPORTED_FIELD`, 201 with fares, open, seat map, booking 5.7M, GET booking).
Two older assertions updated (seat-map key allow-list gains the fares; Day 48A pairing compares
name + seat only). newman: Day 49A 8/8 assertions; Day 46 17/17; Day 47 18/18; Day 48A 21/21;
Day 48B (1 of 2) 6/6. (Day 44's folder needs a `bookingId` from another folder; it fails the same
way without today's change.)

**Docs:** README (new section "Fares and the price snapshot", create body, audit table, notifier,
migration table, the psql hint for a fare, limitations); domain-model Existing for BR-MONEY-01,
BR-FLT-09, BR-BOOK-03 and the gap table; ADR-004 Day 49A addendum (measured table); English note
`docs/learnings/money-and-price-snapshots.md` (+ index row) and a Day 49A paragraph in
`evolving-event-contracts.md`. Vietnamese: `on-tap-nhanh-day-01-48b.md` → `-49a.md` (`git mv`,
links fixed), `race-conditions/09-chup-gia-va-khoa-dong-gia.md` + README rows, interview
(database 10–11, concurrency 13, testing 11, 2-minute story), use-cases flights/bookings/README,
migrations 21–24, README "Cập nhật đến Day 49A". All relative links checked.

Machine left as found: postgres and rabbitmq running; app and flight-notifier stopped; identity
dev process stopped.

## Test count reconciliation

```text
Unit (api):   377 (Day 48B) + 8 (Step 2: Money)
              + 10 (Step 4: create-flight 2, flights API 2 + fare subtests 8 − price/currency subtests 4,
                    flight contract on fake 2)
              + 5 (Step 5: create-booking 2, booking contract on fake 2, bookings API 1) = 400
Integration:  140 + 2 (Step 4: flight contract) + 2 (Step 5: booking contract)
              + 8 (Step 6: A, A missing fare, B1, B1 auto, B1 control, B2, B2 control, C) = 152
Notifier:     10 + 2 (flight-created fares) + 2 (booking-held prices) = 14.   Identity: 12.
```

## Not today

- **Payment** (49B): charges `booking.total`; `HELD → CONFIRMED` on the `> now` side of BR-BOOK-10.
- No endpoint changes a fare; one that is added must keep BR-FLT-09 and go through
  `UPDATE flight_fares` (so holds still order against it).
- `flight-created` still sends deprecated `priceInCents`/`currency` (contract step later).
- "Lowest price" on the flight list and per-fare-class availability (no story yet).
- Carried: removing the `booking-created` contract once its queue is empty, the release
  `ORDER BY` survivor, the outbox relay not being multi-instance safe.

## DAY 49A SUMMARY

Flights have a fare per fare class in whole đồng (`Money`, never ×100), for exactly the classes
their aircraft has; the old `price_in_cents` (đồng under a cents name, VND or USD) is gone through
expand → backfill → contract, which refused on dev data until a person set the BUSINESS and USD
fares. A hold copies each seat's fare onto its passenger in the same statement that holds it, with
the fare rows share-locked: a fare change waits for a hold in progress, a hold waits for an
uncommitted change and then takes it, and without the lock a booking was shown to commit after a
change with the old fare. A `FOR SHARE` CTE only locks when the query reads it — the one mutation
only the race test caught. The booking total is derived, and both events carry the prices as
optional fields.

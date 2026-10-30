# Domain Model

How the booking domain works inside: entities, aggregates and the invariants they protect, lifecycles, the business-rule catalogue, and who may do what. Terms are defined in the [glossary](./scope.md#glossary). The stories these rules serve are in [scope.md](./scope.md).

This document describes the **target** model for phase D, not what the code does today. [Gap vs current code](#gap-vs-current-code) lists the difference.

## Entities and value objects

**Value objects** have no identity of their own; two with equal fields are the same value.

| Value object | Fields | Notes |
|---|---|---|
| `Money` | `amount: integer`, `currency: "VND"` | Integer in the currency's smallest unit, never a float (`0.1 + 0.2 !== 0.3`). For VND that is whole đồng: `1 500 000` is 1.5 million đồng, never ×100 (Decision 13). One currency today (BR-MONEY-01), but the code is stored so a second one is a data change. |
| `SeatPosition` | `row: integer ≥ 1`, `letter: "A"–"K"` | Rendered `12A`. Unique within one SeatLayout. |
| `BookingReference` | 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` | No `0/O`, `1/I` because people read it aloud (BR-BOOK-05). |

**Entities** have an identity (UUID) that stays the same while their data changes.

| Entity | Key attributes |
|---|---|
| `Airport` | `id`, `code` (IATA, unique), `name`, `city`, `timeZone` (IANA name) |
| `Aircraft` | `id`, `registration`, `model` |
| `Seat` | `aircraftId`, `position: SeatPosition`, `fareClass` |
| `Flight` | `id`, `flightNumber`, `originAirportId`, `destinationAirportId`, `aircraftId`, `departureAt`, `arrivalAt`, `status`, `fares: { ECONOMY?: Money, BUSINESS?: Money }` (exactly the classes its aircraft has seats in, BR-FLT-09) |
| `FlightSeat` | `flightId` + `position` (composite key, no surrogate id), `fareClass`, `status`, `bookingId?` (no version column: `status` itself is the guard, ADR-004; see Decision 10) |
| `Booking` | `id`, `reference`, `flightId`, `ownerAccountId`, `status`, `total: Money` (derived: the sum of its passengers' prices, Decision 13), `holdExpiresAt`, `createdAt` |
| `BookingPassenger` | `bookingId`, `position` (1–9, request order), `name`, `seat: SeatPosition` (a display copy; the truth is `FlightSeat.bookingId`, Decision 11), `fareClass`, `price: Money` (snapshot) |
| `Payment` | `id`, `bookingId`, `accountId`, `amount: Money` (captured in phase 1), `status`, `providerReference?`, `failureReason?`, `createdAt`, `updatedAt`. The Idempotency-Key and the request fingerprint live in a separate `idempotency_keys` record that points at the payment (Decision 14): a key exists before its payment does, and a key may end without one (`404`). |

`Account` is **not** an entity of this service. It lives in Identity, and `api` only knows its id (`ownerAccountId` = JWT `sub`).

## Relationships

```text
Airport 1 ──< * Flight (origin)                 Aircraft 1 ──< * Seat         (the layout)
Airport 1 ──< * Flight (destination)            Aircraft 1 ──< * Flight
                    │
                    │ 1                           generated once, when the flight is scheduled:
                    └──< * FlightSeat  <───────── one FlightSeat per Seat of the aircraft (BR-SEAT-03)
                              ▲ 0..1
                              │ held / booked by
Account(id only) 1 ──< * Booking 1 ──< 1..9 BookingPassenger ── 1 FlightSeat
                              │ 1
                              └──< * Payment   (at most one SUCCEEDED, BR-PAY-05)
```

## Aggregates and invariants

An aggregate is the set of data that must be consistent **together, immediately**, inside one transaction. A rule spanning two aggregates is allowed to be consistent **eventually**, through events.

| Aggregate (root) | Contains | Invariants it protects |
|---|---|---|
| **Airport** | Airport | Code is 3 uppercase letters and unique (BR-REF-01); time zone is a valid IANA name (BR-REF-04) |
| **Aircraft** | Aircraft + its Seats | Registration unique (BR-REF-02); seat positions unique, every seat has a fare class (BR-REF-03); layout is bounded (BR-REF-06) |
| **Flight** | Flight + its FlightSeats (seat inventory) | Arrival after departure, origin ≠ destination (BR-FLT-01/02); status follows the lifecycle (BR-FLT-05); **a FlightSeat is held or booked by at most one active Booking** (BR-SEAT-01); a multi-seat hold is all-or-nothing (BR-SEAT-02); fares cover exactly the fare classes it has seats in (BR-FLT-09) |
| **Booking** | Booking + BookingPassengers | Owned by exactly one account (BR-AUTH-01); 1–9 passengers, one distinct seat each (BR-BOOK-01/02); prices are a snapshot taken at hold time (BR-BOOK-03); status follows the lifecycle |
| **Payment** | Payment | One idempotency key ⇒ one payment (BR-PAY-01/02); amount equals the booking total (BR-PAY-03) |

### Decisions

**1. Seat status belongs to the Flight side (the seat inventory), not to Booking.**
"A seat is sold at most once" is a rule about the *flight's* inventory: two different bookings compete for it. Putting status on `FlightSeat` makes the rule one conditional `UPDATE … WHERE status = 'AVAILABLE'` per seat (ADR-004), the same OCC shape as today's `reserveSeat`. Putting it inside Booking would leave nothing but a database unique constraint across bookings, and the Flight side would not know which seats are sold, though it needs that for the seat map, the load factor and cascading cancellation.

**2. A multi-seat hold is all-or-nothing (BR-SEAT-02).**
A family that cannot sit together usually does not want a partial booking. A partial hold would also need a "short of seats" booking state. Mechanically, all seats are held in **one transaction** with one conditional `UPDATE` per seat. If any update affects 0 rows, the use case returns `seats-unavailable` with the losing positions and the transaction rolls back, releasing the seats it had already claimed. The ADR-004 addendum applies: once a miss is detected, no further query runs in that transaction.

**3. `availableSeats` becomes derived, not stored.**
Until Day 46 `flights.available_seats` was the inventory. Once FlightSeats exist, a stored counter would be a second copy of the truth that can drift. Availability is computed as a count of `FlightSeat` rows with `status = 'AVAILABLE'` (per fare class). The existing `reserveSeat`/`releaseSeat` counter logic is replaced, not kept alongside.
*Done Day 47:* the column is dropped; `availableSeats` is counted on every read (one total today, not yet per fare class). A booking claims one concrete seat with `FOR UPDATE SKIP LOCKED` rather than a plain conditional `UPDATE`: when any of many seats will do, OCC would make concurrent bookers collide on the same "first free" seat (ADR-004 addendum).

**4. Booking prices are a snapshot.**
`BookingPassenger.price` and `Booking.total` are copied from the flight's fares when the hold is created. If an admin changes a fare afterwards, the customer still pays the price they were shown. That is the only defensible answer to "which price does the customer pay?", and it keeps Payment independent of later fare edits.

**5. One currency (VND), stored as integer minor units.**
VND has no subunit in practice, so the amount is whole đồng (the field is `amount` since Day 49A, Decision 13). `Money` still carries `currency`, so a second currency later means new data plus conversion rules, not a schema redesign. Multiple currencies are in [Won't](./scope.md#wont).

**6. Airports get a surrogate key; the IATA code is a unique business identifier (Day 45).**
IATA codes are short and readable, but they are reassigned when an airport closes and occasionally changed. As a primary key referenced by every flight, a changed code would mean rewriting those references. A `uuid` key never changes; `code` stays unique and is how people and the API refer to an airport. Flights reference `originAirportId`/`destinationAirportId` from phase D step 3.

**7. An airport stores an IANA time-zone name, never an offset (Day 45).**
`+07:00` is an offset at one moment; `Europe/London` is `+00:00` in winter and `+01:00` in summer. Instants stay in UTC (`timestamptz`); local times are computed from the zone when needed (e.g. "flights on 2026-11-10" in search means the origin's local date). The name is validated on **write** only: stored rows are never re-validated on read, so a Node upgrade that renames or aliases a zone cannot turn existing data invalid.

**8. A seat layout is a template; flights snapshot it (Day 45).**
Seats belong to the aircraft and have no status. When a flight is scheduled it gets its own FlightSeats copied from the layout (BR-SEAT-03), so a later layout change cannot alter seats already sold, the same reasoning as price snapshots (Decision 4). Seats are stored one row each (`seats`, primary key `aircraft_id, row, letter`) so the database itself rejects a duplicate position (BR-REF-03) and step 4 can generate FlightSeats with one `INSERT … SELECT`.

**9. `CLOSED` and `DEPARTED` are derived from the clock, not stored (Day 46, [ADR-008](../adr/008-time-derived-flight-status.md)).**
A status set by a person (open, cancel) must be stored. A status that is only a consequence of time ("sales close 1 h before departure") can always be computed: `effective = CANCELLED if cancelled; DEPARTED if now ≥ departure; CLOSED if OPEN and now ≥ departure − 1 h; otherwise the stored status`. Storing it would need a job, a plan for a late job, and a race between the job and someone holding a seat at 59 minutes. Derived, it is always right, and the seat-hold `UPDATE` checks the same condition in its `WHERE` clause (`status = 'OPEN' AND departure_at − 1 h > now`), so BR-FLT-06 is enforced atomically like the seat count.

**10. Seat inventory: a copied snapshot, linked from the inventory side (Day 47).**

- **Copy, not reference.** `flight_seats` carries its own `row`, `letter` and `fare_class`, filled from `seats` by one `INSERT … SELECT` when the flight is created. It has no foreign key to `seats`. A reference would make every seat map depend on the template table, and BR-REF-05 ("layouts are never edited") would become the thing keeping sold seats correct, instead of a product rule. A copy is what Decision 8 already says a flight does ("snapshot the layout"), the same reasoning as price snapshots (Decision 4). In phase F the Flight service takes `flight_seats` with it and needs nothing from the template except at creation time. Cost: one extra row per seat per flight, and fare class stored twice.
- **The link lives on `flight_seats.booking_id`, not on `bookings`.** BR-SEAT-01 ("a seat is sold at most once") is a rule about the inventory (Decision 1), so the row that is guarded by `WHERE status = 'AVAILABLE'` is also the row that says who has it. In phase F the two tables are in different databases: the foreign key to `bookings` is dropped (as `owner_account_id` already has none), and `booking_id` stays as a plain reservation id in the Flight service, next to the invariant it protects. A `seat` column on `bookings` would put the invariant in Booking's database, where a unique constraint across bookings would be the only guard. Booking will keep a *copy* of the seat code for display (step 5 `BookingPassenger`), never the source of truth.
- **Statuses on Day 47: `AVAILABLE` and `BOOKED` only** (`HELD` added on Day 48A, Decision 11). An active booking occupies a `BOOKED` seat. `HELD` arrives with timed holds (step 5) and is added to the `CHECK` then. Listing it now would allow a value no code writes and no test covers; widening a `CHECK` is a one-line migration. A second `CHECK` ties the columns together: `booking_id` is set exactly when the seat is not `AVAILABLE`.
- **One booking occupies at most one seat: enforced today.** A unique index on `booking_id` (where not null) is true for every booking that can exist now (one passenger each). Step 5 (1–9 passengers) drops it on purpose, in a migration that says why. Until then it catches a double allocation bug that no test thought of. A constraint that is right today protects data until it is relaxed deliberately. *(Relaxed on Day 48A, Decision 11: one **passenger** occupies one seat.)*
- **The FK `flight_seats.booking_id → bookings` is `DEFERRABLE INITIALLY DEFERRED`.** `CreateBooking` claims the seat *before* inserting the booking (unchanged order). The booking id is generated first and written onto the seat, and the FK is checked at commit, when the booking row exists. The other order (insert the booking, then claim) would cost a write and a rollback on every sold-out request. Accepted trade-off: a missing booking would surface at `COMMIT`, not at the statement. That can only be a bug, since both writes are in one use case.

**11. Several passengers per booking; bookings move to the `HELD` lifecycle (Day 48A).**

- **Legacy bookings: `active` → `CONFIRMED`, `cancelled` → `CANCELLED`.** Before Day 48A a booking kept its seat for good and nothing could make it lapse: there was no payment and no hold. "Active" therefore meant "confirmed". Mapping it to `HELD` would be wrong on the day the expiry job arrives (48B): every old booking would expire 15 minutes later and release seats its owner believes are theirs. A legacy `CONFIRMED` booking has no hold deadline, which the schema allows (the deadline is required only while `HELD`).
- **The seat link stays on `flight_seats.booking_id`, now shared by several seats.** Decision 10 still holds: BR-SEAT-01 is guarded by the inventory row, and in phase F the Flight service knows a reservation id (the booking id), not passengers. `UQ_flight_seats_booking_id` is dropped (a booking now holds 1–9 seats) and replaced by a plain index for "release this booking's seats". Which passenger sits where is Booking's business: `booking_passengers` keeps a **copy** of each passenger's seat code for display, with a unique `(booking_id, seat)` (BR-BOOK-02). Releasing a booking stays one `UPDATE … WHERE booking_id = $1`, for cancel today and for the expiry job tomorrow. The alternative, a `booking_passenger_id` on the seat, keeps the pairing in one place but makes every release join through passengers and puts passenger ids into the Flight service.
- **A passenger has one `name`.** The legacy `passenger_name` moves over unchanged. Splitting it into first/last name would need a rule, and every simple rule ("last word is the last name") is wrong for Vietnamese names. Airline-style lookup by reference + last name is not a story here; the reference lookup is owner-scoped instead (US-BOOK-04, BR-AUTH-02).
- **At most 9 passengers (BR-BOOK-01), checked before anything else.** The array length is validated first, before each passenger and before any query, so a request with 10 000 passengers costs one comparison, not 10 000 validations and a seat query (the input-amplification lesson of Day 45, BR-REF-06).
- **Either every passenger names a seat, or none does (BR-BOOK-09).** Mixing would need two hold strategies in one statement (locking named seats in order, skipping locked ones for the rest) for a case no story asks for.
- **System-picked multi-seat holds keep `SKIP LOCKED`, with its edge accepted (decided Day 48B).** Two such holds racing for a flight's last seats can each lock some and skip the other's, so both see too few and both answer `NOT_ENOUGH_SEATS` although one would have fit. A second, waiting pass in (row, letter) order would remove it, at the price of a slower path and a queue on exactly the busiest flights. Not done: the race test measured it 0 times in 200 rounds, the refusal writes nothing, and a client retry succeeds a moment later. Recorded in the README limitations and the ADR-004 Day 48A addendum; revisit if it is ever seen in practice.
- **The gap before payment is accepted, not bridged.** From today a new booking is `HELD`; only payment (step 6) confirms it. Once the expiry job exists (48B), every new booking expires after 15 minutes until step 6 lands. That is the roadmap order already (step 6 follows step 5 directly), so the gap is short and written in the README. A temporary "confirm without paying" endpoint was rejected: it is a shortcut that works in production the day someone forgets the guard around it, and its only users would be tests, which can set the status directly.
- **New event `booking-held` replaces `booking-created` for new bookings.** `booking-created` has meant "a booking now holds a seat for good". A consumer that sends "your booking is confirmed" would listen to it, and receive it for a hold that may expire 15 minutes later. Keeping the name with a new meaning is a contract change no validator can catch. `booking-confirmed` is reserved for payment. The notifier keeps its `booking-created` consumer for messages already in the queue or the DLQ.

**12. Hold expiry: a job frees the seats, every decision checks the deadline itself (Day 48B).**

- **Hybrid, not one mechanism.** Three readers care whether a hold has lapsed, and each gets the cheapest correct answer:
  - **Inventory** (`flight_seats`) is changed by a job (US-SEAT-02). Deriving "free" on read would mean every seat count and every hold joins `bookings` to ask whether the holder's deadline passed. That would lose the partial-index count of Day 47 (Decision 3). The hold statement would also have to *take* a seat still marked `HELD` by someone else, turning "claim a free seat" into "steal an expired one", with two writers on the same row and its own race.
  - **Display** (`GET` a booking, by id, by reference, in a list) derives the status: a `HELD` booking whose deadline has passed is shown as `EXPIRED` before the job reaches it. Same idea as Decision 9 for flights, so the owner never sees a hold that is already over.
  - **Decisions** (cancel today, payment in step 6) put the deadline into their own conditional `UPDATE` (BR-BOOK-10). They never rely on the job having run.
- **An overdue hold is expired, not cancelled.** Cancelling a `HELD` booking whose deadline has passed, before the job swept it, answers `409 BOOKING_EXPIRED` and writes nothing; the job releases the seats and records the expiry. A booking already `EXPIRED` gets the same `409`. The alternative, "cancel wins while the row still says `HELD`", would make the outcome depend on when the job last ran: the same request at the same second would be a cancellation or an expiry depending on a 60-second timer. With the deadline in the `WHERE`, the outcome depends only on the clock, and each booking gets exactly one end (`CANCELLED` or `EXPIRED`), one audit entry and one event.
- **New event `booking-expired`, through the outbox, with a consumer.** A hold that lapses is something a customer would be told about ("your hold on ABC234 has expired"), and other services (phase F) will need to know the reservation is gone. It follows the `booking-held` contract style (reference, flight, seats, deadline, when it expired; no passenger names). The flight-notifier consumes it like the others.
- **Job: every 60 seconds, batches of 50, at most 20 batches per run.** Each batch is one transaction: lock up to 50 due holds with `FOR UPDATE SKIP LOCKED`, mark them `EXPIRED`, release their seats, write one audit entry and one outbox row per booking. `SKIP LOCKED` lets two API instances sweep at the same time without waiting on or double-expiring each other. A run stops when a batch comes back short, or after 20 batches (1 000 bookings), so one run cannot hold the job loop for long. A seat is therefore freed at most about 60 seconds plus one run after its deadline. During that gap the **seat map still shows it `HELD`**: accepted, because the seat cannot be sold twice either way, and the booking itself already reads `EXPIRED`.
- **A failing batch is retried whole, not split.** If one booking in a batch makes the transaction fail, the whole batch rolls back, the job logs `job_failed`, and the next run tries again. Like the outbox relay (Day 24), one bad row can delay the ones behind it (head-of-line blocking). Written in the README limitations; splitting batches on failure is not worth it before such a row has been seen.
- **The 15 minutes stay a constant.** `HOLD_DURATION_MS` is not read from the environment. Making it configurable would exist only to speed up end-to-end tests, and a config value that only tests change is a production setting nobody should touch. Tests move the deadline instead: unit tests with a fake clock, e2e tests by back-dating `hold_expires_at` with `psql`.
- **The system is an audit actor.** Expiry is recorded with actor `{ type: "system", id: "booking-hold-expiry" }`, so the audit log can say *who* ended a booking even when no person did. The actor `CHECK` from Day 38 only requires a non-empty type and id, so no migration is needed.

**Lock order across hold, cancel, expiry and payment.** All of them touch a booking and its seats; each takes its locks in the same direction, so two of them cannot wait on each other in a circle:

| Operation | 1st lock | 2nd lock | Then | Seats locked in |
|---|---|---|---|---|
| Hold, seats chosen (Day 48A) | — (booking is new) | Seats, then a share lock on the flight | Share lock on the flight's fares (Day 49A) | `(row, letter)` order |
| Hold, system-picked (Day 48A) | — | Seats with `SKIP LOCKED` (never waits) | Share lock on the flight's fares (Day 49A) | `(row, letter)` order |
| Cancel | The booking row (conditional `UPDATE`) | The booking's seats | — | `(row, letter)` order, from Day 48B |
| Expire (job) | The due booking rows, `SKIP LOCKED` | Their seats | — | `(row, letter)` order, from Day 48B |
| Confirm payment (phase 3, Day 49B; also reconciliation, Day 49C) | The booking row (conditional `UPDATE`) | The booking's seats | The payment row, then the idempotency row | `(row, letter)` order |
| Record a decline (phase 3 or reconciliation, Day 49C) | The payment row (conditional `UPDATE`) | The idempotency row | — | — |
| Claim due payments (reconciliation job, Day 49C) | The due payment rows, `SKIP LOCKED`; committed before any gateway call | — | — | — |
| Record a refund or its retry (reconciliation job, Day 49C) | The payment row (conditional `UPDATE`) | — | — | — |
| Delete expired keys (cleanup job, Day 49C) | `COMPLETED` idempotency rows only | — | — | — |

The fare share lock (Decision 13, ADR-004 Day 49A addendum) is taken by the hold only. It conflicts with `UPDATE flight_fares`, which no operation in this table performs, so it cannot join a cycle with any of them; a future fare-change endpoint takes the fare rows alone and waits for holds in progress.

Payment phase 1 (Decision 14) takes no lock that matters here: it inserts the payment row (its foreign key takes `KEY SHARE` on the booking, which does not conflict with the `UPDATE` of `status` that cancel, expiry and confirm make) and claims the idempotency row. Cancel and expiry never touch `payments` or `idempotency_keys`, and every operation that locks both a booking and its seats locks the booking first, so no pair in this table waits on another in reverse order. The Day 49C rows keep that: the reconciliation job's claim locks payment rows alone and commits before calling the gateway, recording a result locks the payment before the idempotency row (as phase 3 does), and key cleanup only deletes `COMPLETED` keys, which no other operation locks any more.

Found while planning this day: until Day 48B, cancel released seats with a plain `UPDATE … WHERE booking_id = $1`, which locks them in whatever order the scan returns, not `(row, letter)`. A chosen-seat hold on `[12A, 12B]` could hold 12A and wait for 12B while a cancel of the booking holding both had locked 12B and waits for 12A: a deadlock, which Postgres resolves by failing one of them (`40P01`). Release therefore locks the seats first, `ORDER BY "flight_id", "row", "letter" FOR UPDATE`, and only then updates them; cancel and expiry share that shape (`releaseSeatsOf`). Race test E forces the interleaving with a gate transaction on 12A: a release locking 12B first deadlocked 5 rounds out of 5; the real cancel and sweep, 0. Removing the `ORDER BY` altogether is not caught today — the physical order happens to be `(row, letter)` — the same as the hold's `ORDER BY` (Day 48A): the clause is the guarantee, the plan is not.

**13. Fares: a price per fare class, copied onto each passenger at hold time (Day 49A).**

- **One row per fare class (`flight_fares`), not price columns on `flights`.** Primary key `(flight_id, fare_class)`, `amount_vnd bigint > 0`. Columns such as `economy_price`/`business_price` would have to be nullable for economy-only aircraft and make a third class a schema change. A row per class has the same key as `flight_seats.fare_class`, so the hold joins a seat to its price directly. Cost: reading a flight touches one more table, loaded once per page like airport codes.
- **The classes with a price are exactly the classes with seats (BR-FLT-09).** A price for a class the aircraft lacks is a number nobody can pay; a class with seats but no price is a seat that cannot be held. Creating a flight answers `422 MISSING_FARE` or `422 FARE_CLASS_NOT_ON_AIRCRAFT`. The **application** keeps this rule, not the database: "for every distinct value in that table a row exists in this one" is not a constraint Postgres can declare, and a trigger is not worth it while one use case writes fares. CreateFlight, the contract migration (it refuses existing data that breaks the rule) and tests guard it. No endpoint changes a fare yet; one that arrives must keep the rule too.
- **`amount` is whole đồng, never ×100.** The old column `price_in_cents` already held đồng despite its name (`1500000` was 1.5 million đồng, not 15 000). Storing hundredths would multiply every amount by 100 and invite one forgotten division. The database column is `bigint`, so a total never needs a question about overflow. In TypeScript it is a `number`, exact up to 2^53 − 1 (about 9·10^15 đồng). `pg` returns a `bigint` as a string; the adapter converts it and **throws** if the result is not a safe integer. That cannot happen with real fares, and if it ever does it must fail loudly, not become a rounded price.
- **The price is copied inside the hold statement, with the fare rows share-locked.** The statement that claims the seats also reads the flight's fares `FOR SHARE`, and each passenger stores `fare_class` and `price_vnd`. Changing a fare is an `UPDATE flight_fares`, which needs those rows: it waits for holds in progress, and holds wait for it. So every booking carries the prices from before the change or from after it, never one class old and one new. Reading fares in an earlier query would leave a gap where the price changes between the read and the hold. The `FOR SHARE` on the flight row (Day 46) does not cover this: it conflicts with `UPDATE flights`, not with `UPDATE flight_fares`.
- **`Booking.total` is derived, not stored.** It is the sum of the passengers' prices, which never change after the hold, so a stored total would be a second copy that could only disagree. One shared function computes it on every read; payment (49B) charges exactly that.
- **Bookings made before Day 49A are priced at migration time, and say so.** Their passengers get the fare of their seat's class as it is when the migration runs, not the price at their hold, which was never recorded. The alternative, a null price, would make every reader and payment handle "a booking without a price" forever. Written in the migration and here; only dev data exists.
- **No exchange rate in code.** The backfill copies `price_in_cents` into the ECONOMY fare for `VND` flights only. A `USD` flight or a BUSINESS cabin has no price that can be derived: the contract migration refuses with the list of flights and a `psql` hint, and the operator sets the fares. A rate written into a migration would be wrong the next day and would quietly price every seat with it.
- **Event contracts grow; nothing is removed yet.** `booking-held` gains `fareClass` and `price` per passenger and a `total`. `flight-created` gains `fares` and keeps sending `priceInCents` (the ECONOMY fare, or the lowest one if there is no ECONOMY) and `currency: "VND"`, marked deprecated until no consumer reads them. The new fields are optional in the parsers, so messages already in a queue or the DLQ stay valid (expand → contract, as for events since Day 46).

**14. Payment runs in three phases around the gateway call; an Idempotency-Key makes a retry safe (Day 49B, [ADR-009](../adr/009-external-calls-outside-transactions.md)).**

- **The gateway is never called inside a database transaction.** A transaction that waits on the network keeps the booking and seat rows locked for as long as the provider takes (cancel waits behind it; the expiry job's `SKIP LOCKED` silently skips the booking instead), holds a pool connection per waiting customer, and cannot take money back by rolling back. So: **phase 1** (short transaction) claims the key, checks the booking, records a `PROCESSING` payment with the amount; **phase 2** (no transaction) calls the gateway; **phase 3** (short transaction) records the outcome and, on success, confirms the booking. Race test E measures the alternative.
- **This revises Day 43's "no `PENDING` state".** That decision assumed the simulator answers inside the same transaction, so a payment was never "started but not finished". With the call outside the transaction there is a real window, and something must say *a payment has started* to a repeated request, to a restart after a crash, and to reconciliation (49C). That is the `PROCESSING` row. The Payment lifecycle below replaces the Day 43 table; Day 43's reasoning was right for the design it assumed.
- **States:** `PROCESSING`, `SUCCEEDED`, `FAILED` (the gateway declined), `REFUND_PENDING` (charged, but the booking could not be confirmed), `REFUNDED`. `FAILED` keeps the name scope.md and the API already use; "declined" is its reason. A charged payment whose booking lost the race is not `SUCCEEDED`: BR-PAY-05's unique index means "this booking is paid", and that booking is not.
- **The race with expiry and cancel: refund always, plus a 60-second margin (BR-PAY-07).** Confirmation is decided at **phase 3's** instant, with BR-BOOK-10's `> now` unchanged, so the expiry job and cancel need no knowledge of payments. When phase 3 loses (the booking expired or was cancelled while the gateway was charging), the payment becomes `REFUND_PENDING`, the transaction commits, the gateway refunds, and a short transaction records `REFUNDED`. To make that rare, phase 1 only starts a payment while the hold has **more than 60 seconds** left. 60 s is far longer than a gateway normally needs and costs the customer 1/15 of the hold. Not done: freezing expiry while a payment is `PROCESSING` (fewer refunds, but it adds payments to the Day 48B sweep and, without 49C, a crash after phase 1 would hold the seats forever).
- **Record the refund before making it.** `REFUND_PENDING` is committed *before* the gateway's refund call. A crash after the commit leaves a row reconciliation can find and finish; the other order (refund, then write) would leave money returned while the database still says the payment stands, with nothing pointing at it.
- **Amount: captured once, not re-checked.** The request carries `amount`, which must equal `booking.total` (BR-PAY-03, `422 PAYMENT_AMOUNT_MISMATCH`), so a customer never pays a total other than the one they saw. Phase 1 stores it on the payment. Phase 3 does not compare again: the total is derived from price snapshots that cannot change after the hold (Decision 13).
- **Idempotency-Key, required.** Missing → `422 IDEMPOTENCY_KEY_REQUIRED`; 1–255 visible ASCII characters. Scope `(account, operation = 'pay-booking', key)`: two accounts may use the same string and never see each other's result (the Day 44 rule that every lookup carries the owner). A fingerprint (SHA-256 of the canonicalised `method`, `path` and validated body, keys sorted) is stored with the key; the same key with a different fingerprint is `422 IDEMPOTENCY_KEY_REUSED` (BR-PAY-02). A second request while the first is in flight gets `409 IDEMPOTENCY_KEY_IN_PROGRESS` and is not processed. The final response (status and body) is written in the **same transaction** as the business outcome, so a "completed" key can never disagree with the data. Kept for 24 h; deleted by a job since Day 49C (Decision 15).
- **What is replayed and what is not.** Stored: every final business outcome (`201`, `402 PAYMENT_DECLINED`, `409 BOOKING_NOT_PAYABLE`, `404 BOOKING_NOT_FOUND`). Not stored, so the client may retry with the same key: validation errors (checked before the key is claimed), `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_IN_PROGRESS`, and any `5xx`. A replay answers with the identical status and body plus `Idempotent-Replayed: true`.
- **Two keys, one booking.** The key stops a *repeated* request, not two different ones (two tabs). The database does: a partial unique index allows at most one `PROCESSING` and at most one `SUCCEEDED` payment per booking. Phase 1 inserts with `ON CONFLICT ("booking_id") WHERE "status" = 'PROCESSING' DO NOTHING`, so the loser gets `409 PAYMENT_IN_PROGRESS` without a `23505` aborting the transaction (ADR-004 Day 38 addendum), and its key is released.
- **A gateway error of unknown outcome keeps the key in progress** (finished by reconciliation since Day 49C, Decision 15). If phase 2 threw, releasing the key would let a retry charge a second time while the first charge may have gone through. Today the payment stays `PROCESSING` and the key `IN_PROGRESS`; the payment's own id is sent to the gateway as *its* idempotency key, which is what makes a later retry or reconciliation safe. The simulator never throws this way.
- **HTTP:** `201` confirmed; `402 PAYMENT_DECLINED` (booking stays `HELD`, pay again with a new key); `409 BOOKING_NOT_PAYABLE` (not `HELD`, expired, under the margin, or lost the race and refunded); `409 IDEMPOTENCY_KEY_IN_PROGRESS`; `409 PAYMENT_IN_PROGRESS`; `422` for the key and amount rules above; `404` for another account's booking; `403` for admins (BR-AUTH-03). No `Location` and no `GET` for a payment: no story reads one.
- **Audit and events.** `BOOKING_CONFIRMED` (actor: the paying account) and `PAYMENT_FAILED`, `PAYMENT_REFUND_PENDING`, `PAYMENT_REFUNDED` (target: the payment). The refund is made by the system, like the expiry job: actor `system/payment-refund` on Day 49B, `system/payment-reconciliation` since Day 49C, when the job became the only place that refunds (Decision 15). Success emits `booking-confirmed` through the outbox: the first event meaning "this customer really has these seats", which `booking-held` deliberately is not (Decision 11).

**15. Reconciliation finishes every payment the request could not, and nothing is ever guessed (Day 49C, [ADR-010](../adr/010-payment-reconciliation.md)).**

A call to the gateway has three results, not two: charged, declined, or **unknown**. It is unknown when the request left the process but no answer came back (timeout, reset connection, crash right after sending). The provider may have charged, may not have, or may still charge when a delayed request arrives. Day 49B left such a payment `PROCESSING` with nothing to move it on. Four stopping points leave a trace in the database: after phase 1 (`PROCESSING`, the provider has nothing), during the charge (`PROCESSING`, unknown), after a charge but before phase 3 commits (`PROCESSING`, money taken), and after `REFUND_PENDING` commits (refund not made, or not known to be made). This decision says who finishes each of them.

- **The gateway call has a timeout, at the adapter.** `PAYMENT_GATEWAY_TIMEOUT_MS`, default 10 s, at most 20 s. The adapter cuts the call (`AbortController`) and answers `unknown`; use cases never time anything themselves. Kept well under BR-PAY-07's 60 s start margin: timeout plus the 30 s reconciliation margin is under 60 s, so a payment that started at the margin and timed out is usually reconciled while its hold is still valid. When the job runs later than that, the booking has expired and the payment is refunded, which is correct, only less pleasant.
- **An unknown outcome never becomes `FAILED` (BR-PAY-08).** Marking it failed would let the customer pay again while the first charge may have gone through: charged twice. The payment stays `PROCESSING`, the key stays `IN_PROGRESS`, booking and seats stay `HELD`. The customer gets **`202 Accepted`** with the payment (`status: "PROCESSING"`). That answer is not stored: the same key gets `409 IDEMPOTENCY_KEY_IN_PROGRESS` until reconciliation finishes, then the final answer, replayed with `Idempotent-Replayed: true`. The retry with the same key *is* the way to read the result, so no `GET` for a payment is added. `202`, not `504`: the request was accepted and is being finished, and a `5xx` tells most clients "this failed", which is exactly the guess the rule forbids.
- **Reconciliation charges again with the same payment id, it does not only ask.** The payment id has been the provider's idempotency key since Day 49B, so a second `charge` with it returns the first charge's result if there was one, and charges now if there was none. Either way, after that call the provider has exactly one result for this id, and a delayed copy of the first request that arrives later is recognised as the same charge. Only asking ("what happened to this id?") is weaker: "not found" does not mean "never will be", because a request still in flight can arrive after the question. Marking the payment failed on "not found" and then seeing the delayed request charge is precisely the double-charge case. Asking would need an extra guarantee from the provider (a request-age limit after which it refuses old requests) and a wait longer than that. Cost of charging again: the payment must keep the payment-method token it was started with (`payment_method_token`, a provider token, never card data), and a payment whose first request never reached the provider is charged at reconciliation time, later than the customer pressed "pay".
- **The job never steps on a request still running.** Phase 1 sets `next_attempt_at = now + timeout + 30 s`; the job only takes `PROCESSING` payments whose `next_attempt_at` has passed. A live request ends (answered or timed out) before that. If it is still slower (a slow phase 3), the conditional transitions decide: `markSucceeded` and its siblings only move from the expected state, so one side wins and the other stops. The age gate makes the collision rare; the conditional `UPDATE` makes it harmless; the provider's idempotency makes even the duplicate charge call harmless.
- **A lease, not a long lock.** The job may not hold a row lock across the gateway call (ADR-009), so `SKIP LOCKED` alone cannot stop a second instance from taking the same payment once the claim committed. The claim transaction therefore pushes `next_attempt_at` forward by the lease (timeout + 30 s) and counts the attempt; other instances skip the row until the lease runs out, which only happens if the instance that took it died. The same column carries the age gate, the lease and the retry backoff, so there is one "when may this be touched next" and one partial index. Not done: relying on the provider's idempotency alone; every collision would be an extra call to a provider that bills per call and rate-limits.
- **One phase 3, shared.** When the job has a definite answer it runs the same code as the request (`SettlePayment`): charged → confirm if the hold is still valid (`> now`, BR-BOOK-10), otherwise `REFUND_PENDING`; declined → `FAILED`. It also completes the Idempotency-Key with the final response, so the customer's retry gets an answer. The job knows no account or key, so phase 3 — the request's too — finds the key by its payment (`UQ_idempotency_keys_payment_id`: a payment is started by exactly one key). A second copy of phase 3 in the job would drift from the request's.
- **When the request and the job do meet.** A request that outlives timeout + 30 s while the job settles its payment reaches phase 3 second: its conditional transition matches nothing, it throws, and its transaction — booking confirmation included — rolls back. That request answers `500`; its key already holds the job's final answer, which a retry gets. Accepted: it needs a request slower than its own timeout by 30 s, and the result is still correct (race test, Day 49C).
- **Refunds only happen in the job.** The request commits `REFUND_PENDING` and answers `409 BOOKING_NOT_PAYABLE` at once, with `next_attempt_at = now`, and the job refunds on its next run. One code path calls `refund`, and the customer no longer waits for a second gateway call (16 s in the Day 49B e2e). Cost: the refund starts up to one job interval (30 s) later.
- **Refund retries are bounded, and the last state is for people (BR-PAY-09).** A refund that fails, or whose outcome is unknown, is retried with the same payment id after 1, 2, 4 and 8 minutes. After the fifth failed attempt, or at once when the gateway says retrying cannot help (`retryable: false`, e.g. the card account is closed), the payment becomes **`REFUND_FAILED`**, audited as `PAYMENT_REFUND_FAILED` and logged as an error (`payment_refund_needs_attention`). A person settles it outside the system; there is no endpoint for that yet, and the "alert" is a log line until phase G. This is Day 23's dead-letter idea for money: a failure is not retried forever and not lost, it is put where someone sees it.
- **`PROCESSING` has no such last state.** Its outcome is unknown, and any terminal state would be a guess; it would also free the booking's `PROCESSING` slot (`UQ_payments_booking_processing`) for a second charge. So it is retried with the same backoff, capped at 10 minutes, with a warning from the third attempt on, until the gateway answers.
- **Idempotency-Keys live 24 h (BR-PAY-10).** A job deletes `COMPLETED` keys whose `created_at` is older than 24 h, in batches (`IDX_idempotency_keys_created_at`, Day 49B). It never deletes an `IN_PROGRESS` key: phase 1 claims the key and attaches the payment in one transaction, so every `IN_PROGRESS` key belongs to a `PROCESSING` payment, and reconciliation completes both. After deletion the same request is simply a new request, and the **domain** refuses a second charge: the booking is `CONFIRMED` (phase 1 answers `409 BOOKING_NOT_PAYABLE`) and `UQ_payments_booking_succeeded` allows one success per booking. The key is the convenient layer for short-term retries; the database invariants are the layer that must still hold when it is gone. Age is counted from `created_at`, not `completed_at`: a key finished late by reconciliation may be deleted soon after, and that is safe for the same reason.
- **Audit and actor.** Everything the job does is recorded with actor `system/payment-reconciliation`, which replaces Day 49B's `system/payment-refund`: the job is now the only system actor in payments. New audit action `PAYMENT_REFUND_FAILED`.

### What happens to these boundaries in phase F

When Flight and Booking become separate services with separate databases, "hold seats" runs in the **Flight service**, which owns the inventory. Booking then cannot hold seats and create itself in one transaction any more. It will need a request to the Flight service plus compensation when a later step fails: a saga, or at minimum a reservation with its own expiry on the Flight side. This is accepted: the boundary was chosen so that the *invariant* (BR-SEAT-01) stays inside one service. Only the *workflow* becomes distributed, which is the easier half to make eventually consistent. Today's single transaction across both aggregates is a phase-D convenience, and it is written here so nobody mistakes it for a permanent guarantee.

## Lifecycles

### Flight

| From | To | Triggered by | Condition | Side effects |
|---|---|---|---|---|
| — | `SCHEDULED` | Admin (US-FLT-01) | BR-FLT-01/02/03/04 | One FlightSeat per Seat, all `AVAILABLE`; `flight-created` |
| `SCHEDULED` | `OPEN` | Admin (US-FLT-02) | Departure more than 1 h away | Bookable |
| `OPEN` | `CLOSED` | **Derived from time** (Decision 9) | Now ≥ departure − 1 h (BR-FLT-06) | No new holds; existing holds may still be paid until they expire (BR-PAY-06) |
| `CLOSED` | `DEPARTED` | **Derived from time** (Decision 9) | Now ≥ departure | Remaining `HELD` bookings expire (expiry job, step 5) |
| `SCHEDULED` / `OPEN` / `CLOSED` | `CANCELLED` | Admin (US-OPS-01) | Not departed | Every `HELD`/`CONFIRMED` booking → `CANCELLED` (reason `FLIGHT_CANCELLED`, ignores BR-BOOK-06); one `booking-cancelled` per booking; `flight-cancelled` |

- **Stored** statuses: `SCHEDULED`, `OPEN`, `CANCELLED` (set by people). **Derived** statuses: `CLOSED`, `DEPARTED` (consequences of the clock). The effective status is computed from the stored one, the departure time and now; every rule below is checked against the effective status.
- **Terminal:** `DEPARTED`, `CANCELLED`.
- **Forbidden:** anything out of a terminal state; `OPEN → SCHEDULED`; `CLOSED → OPEN` (re-opening after closing would bypass BR-FLT-06).
- **Not yet reachable (Day 46):** `→ CANCELLED`. Without the cascade of step 9 it would leave active bookings on a cancelled flight, so no route offers it until then.
- **Reschedule** (US-FLT-03) is not a status change. It is allowed in `SCHEDULED`/`OPEN` and re-validates BR-FLT-01/03/06.

### FlightSeat

| From | To | Triggered by | Condition | Side effects |
|---|---|---|---|---|
| — | `AVAILABLE` | Flight scheduled | — | — |
| `AVAILABLE` | `HELD` | User creates a booking (US-BOOK-01) | Flight `OPEN`; all requested seats `AVAILABLE` (BR-SEAT-02) | `bookingId` set |
| `HELD` | `BOOKED` | Payment succeeds | Booking `HELD` → `CONFIRMED` in the same transaction | — |
| `HELD` | `AVAILABLE` | Hold expires / booking cancelled while `HELD` | — | `bookingId` cleared |
| `BOOKED` | `AVAILABLE` | Booking cancelled (US-BOOK-05) / seat changed away (US-BOOK-06) | — | `bookingId` cleared |
| `AVAILABLE` | `BOOKED` | Seat changed to (US-BOOK-06) | Same fare class (BR-BOOK-07) | `bookingId` set |
| any | `UNAVAILABLE` | Flight cancelled | — | No longer sellable |

- **Terminal:** `UNAVAILABLE`.
- **Forbidden:** `HELD → HELD` for a different booking, and `BOOKED → HELD`. Both are exactly what the `WHERE status = 'AVAILABLE'` guard prevents.
- **Reachable on Day 47:** only `AVAILABLE → BOOKED` (a booking is created; the seat is any free one, lowest row then letter) and `BOOKED → AVAILABLE` (the booking is cancelled). `HELD` and `UNAVAILABLE` come with steps 5 and 9 (Decision 10).
- **Reachable from Day 48A:** `AVAILABLE → HELD` (all of a booking's seats in one statement, or none) and `HELD → AVAILABLE` (the booking is cancelled). `BOOKED → AVAILABLE` stays for legacy `CONFIRMED` bookings. `HELD → BOOKED` arrives with payment (step 6), expiry with 48B.
- **From Day 48B:** `HELD → AVAILABLE` also by the expiry job. Release, by cancel or expiry, locks the booking's seats in `(row, letter)` order before updating them (Decision 12, lock order).

### Booking

| From | To | Triggered by | Condition | Side effects |
|---|---|---|---|---|
| — | `HELD` | User (US-BOOK-01) | BR-BOOK-01/02/09, BR-FLT-06, BR-SEAT-02 | Seats `HELD`; `holdExpiresAt` = now + 15 min; unique reference (BR-BOOK-05); `booking-held` (Decision 11) |
| `HELD` | `CONFIRMED` | Payment succeeds (US-PAY-01) | `status = 'HELD'` **and** `holdExpiresAt > now`; flight `OPEN` or `CLOSED` (BR-PAY-06) | Seats `BOOKED`; `booking-confirmed` |
| `HELD` | `EXPIRED` | System job (US-SEAT-02), actor `system/booking-hold-expiry` | `status = 'HELD'` **and** `holdExpiresAt ≤ now` (BR-BOOK-10) | Seats `AVAILABLE`; `booking-expired` (Decision 12) |
| `HELD` | `CANCELLED` | Owner (US-BOOK-05) | `holdExpiresAt > now` (BR-BOOK-10); otherwise `409 BOOKING_EXPIRED` | Seats `AVAILABLE`; `booking-cancelled` |
| `HELD` | `CANCELLED` | Flight cancellation (US-OPS-01) | — | Seats `AVAILABLE`; `booking-cancelled` with reason |
| `CONFIRMED` | `CANCELLED` | Owner (US-BOOK-05) | Departure more than 24 h away (BR-BOOK-06) | Seats `AVAILABLE`; `booking-cancelled` |
| `CONFIRMED` | `CANCELLED` | Flight cancellation (US-OPS-01) | — (window does not apply, BR-FLT-07) | Seats `UNAVAILABLE`; `booking-cancelled` with reason |

- **Terminal:** `EXPIRED`, `CANCELLED`. A departed flight's `CONFIRMED` bookings simply stay `CONFIRMED`; "flown" is not modelled.
- **Forbidden:** `CANCELLED → CONFIRMED`, `EXPIRED → CONFIRMED` (a late payment must not resurrect a booking whose seats may already be resold), `CONFIRMED → HELD`.
- **Reachable from Day 48A:** `— → HELD` and `HELD → CANCELLED`, plus `CONFIRMED → CANCELLED` for legacy bookings (no 24 h window yet, step 7). `→ EXPIRED` comes with 48B, `→ CONFIRMED` with payment (step 6).
- **Reachable from Day 48B:** `HELD → EXPIRED` (the job). `HELD → CANCELLED` by the owner only while the hold is valid. **Stored vs shown:** between the deadline and the job's next run the row still says `HELD`; every read shows it as `EXPIRED` (Decision 12), the way a flight's `CLOSED` is derived (Decision 9).

**Race: payment and expiry at the same second.** `HELD → CONFIRMED` and `HELD → EXPIRED` can run at the same moment. Both are conditional `UPDATE bookings SET status = … WHERE id = $1 AND status = 'HELD' AND holdExpiresAt (> | ≤) now`, the ADR-004 pattern already used by `cancel()`, with the BR-BOOK-10 boundary. Postgres row locking makes the second writer re-check the condition against the first writer's committed row, so exactly one wins. If expiry wins, the payment's update affects 0 rows, the payment use case returns `booking-not-payable`, and it must not record a `SUCCEEDED` payment. This gets a race test on Postgres, like Day 39's.
*Revised Day 49B (Decision 14):* this note originally said "create the payment row in the same transaction, after the booking update succeeds". That assumed the gateway answered inside the transaction. With the call outside it, the payment row is created in phase 1 as `PROCESSING`, and money may already be taken when the booking update affects 0 rows. The payment then becomes `REFUND_PENDING` and is refunded, never `SUCCEEDED`. The race itself is unchanged: phase 3's conditional `UPDATE` still decides it.

**Race: cancel and expiry at the same second (Day 48B).** The same shape, decided by BR-BOOK-10. Cancel updates `WHERE status = 'HELD' AND holdExpiresAt > now`; expiry updates `WHERE status = 'HELD' AND holdExpiresAt ≤ now`. For one `now` the two conditions never both hold, so at most one can match. When the two operations read the clock at slightly different instants, both may match in principle; the row lock still lets only the first writer through, and the second re-checks `status = 'HELD'` against the committed row and matches nothing. Either way the booking gets exactly one end, its seats are released once, and there is one audit entry and one event.

### Payment

| From | To | Triggered by | Condition | Side effects |
|---|---|---|---|---|
| — | `PROCESSING` | User (US-PAY-01), phase 1 | Booking `HELD` with more than 60 s left (BR-PAY-04, BR-PAY-07); amount = total (BR-PAY-03); no other `PROCESSING` payment for the booking | Idempotency key claimed; token kept; `next_attempt_at = now + timeout + 30 s` |
| `PROCESSING` | `PROCESSING` | Gateway outcome unknown (request or job) | — | Request answers `202`, nothing stored, key stays `IN_PROGRESS`; job retries later (backoff ≤ 10 min) |
| `PROCESSING` | `SUCCEEDED` | Gateway charged: phase 3 or the job | Booking moved `HELD → CONFIRMED` in the same transaction (`holdExpiresAt > now`) | Seats `BOOKED`; `booking-confirmed`; response `201` stored |
| `PROCESSING` | `FAILED` | Gateway declined: phase 3 or the job | — | Booking stays `HELD`; response `402` stored |
| `PROCESSING` | `REFUND_PENDING` | Gateway charged: phase 3 or the job | The booking could not be confirmed (expired or cancelled meanwhile) | Response `409 BOOKING_NOT_PAYABLE` stored; job refunds on its next run |
| `REFUND_PENDING` | `REFUNDED` | Job, actor `system/payment-reconciliation` | Gateway refunded | — |
| `REFUND_PENDING` | `REFUND_PENDING` | Job | Refund failed or unknown, fewer than 5 attempts, retryable | Next attempt after 1, 2, 4, 8 min |
| `REFUND_PENDING` | `REFUND_FAILED` | Job | Fifth failed attempt, or the gateway says it is not retryable (BR-PAY-09) | Audit `PAYMENT_REFUND_FAILED`; error log `payment_refund_needs_attention` |

- **Terminal:** `SUCCEEDED`, `FAILED`, `REFUNDED`, `REFUND_FAILED` (the last one for the system only: a person settles it). A retry with a new key is a new Payment. A retry with the same key returns the stored result (BR-PAY-01).
- **Every non-terminal state has an owner** (Day 49C, Decision 15): `PROCESSING` and `REFUND_PENDING` carry `next_attempt_at`, and the reconciliation job finishes them. Nothing is left for a person except `REFUND_FAILED`.
- *Revised Day 49C:* until then `PROCESSING` and `REFUND_PENDING` were "not terminal by design, finished in 49C", with nothing to finish them, and the refund was made inside the paying request.
- *Revised Day 49B:* until then this section said "there is no `PENDING` state: the simulator answers synchronously". Calling the gateway outside the transaction (Decision 14) makes "started, not finished" a real state, so it is modelled as `PROCESSING`.

## Business rules

Numbers are fixed here and nowhere else. Code constants and tests reference these IDs.

**Existing** = already enforced in today's code (validation, DB constraint or use case), to be carried over.

| ID | Rule | Existing |
|---|---|---|
| **BR-MONEY-01** | Amounts are integers in minor units with a currency code; the only accepted currency is `VND`. | ✅ Day 49A: `Money { amount, currency: "VND" }` in whole đồng (`api/src/money/money.ts`); `bigint` columns capped at 2^53 − 1 by `CHECK`; `priceInCents`/`currency` rejected (`422 UNSUPPORTED_FIELD`), `USD` gone |
| **BR-REF-01** | An airport code is exactly 3 uppercase letters and unique. | ✅ Day 45: normalized + validation, `UQ_airports_code` + `CHECK` |
| **BR-REF-02** | An aircraft registration is unique. | ✅ Day 45: normalized, `UQ_aircraft_registration` |
| **BR-REF-03** | Seat positions are unique within a layout, and every seat has a fare class. | ✅ Day 45: `expandSeatLayout` + `PK_seats`, fare class `CHECK` |
| **BR-REF-04** | An airport's time zone is a valid IANA name (`Asia/Ho_Chi_Minh`), never an offset. `Etc/*` zones are rejected too: they are fixed offsets in disguise, with an inverted sign (`Etc/GMT+7` is UTC−7), and no airport uses one. `UTC` is allowed. Checked when written, not when read. | ✅ Day 45: `isIanaTimeZone` on write |
| **BR-REF-05** | A seat layout has no edit endpoint. If one is added, it may only change an aircraft no flight references yet; flights already scheduled keep their FlightSeats (BR-SEAT-03). | ✅ Day 45: no edit route exists |
| **BR-REF-06** | A layout has 1–10 cabins, rows 1–99, 1–10 distinct letters `A`–`K` per cabin, no row in two cabins, and at most 900 seats (the A380 is certified for 853). The total is computed from the input **before** seats are generated. | ✅ Day 45: `expandSeatLayout`, row/letter `CHECK` |
| **BR-FLT-01** | Arrival is after departure. | ✅ validation + `CHECK` |
| **BR-FLT-02** | Origin and destination differ. | ✅ validation + `CHECK` |
| **BR-FLT-03** | An aircraft never operates two flights whose occupancy windows `[departureAt, arrivalAt + turnaround)` overlap (BR-FLT-08). A `CANCELLED` flight occupies nothing. ✅ Day 46: `EXCL_flights_aircraft_schedule` (GiST, `WHERE status <> 'CANCELLED'`) → `409 AIRCRAFT_UNAVAILABLE`; race-tested |
| **BR-FLT-04** | Flight number + departure instant is unique. | ✅ `UNIQUE` |
| **BR-FLT-05** | Flight status changes only along the Flight lifecycle table. | ✅ Day 46: `transitionFlight` table + compare-and-set `changeStatus`; `SCHEDULED → OPEN` reachable (`→ CANCELLED` from step 9) |
| **BR-FLT-06** | Seats can be held only while the flight is `OPEN`; sales close **1 hour** before departure. | ✅ Day 46: condition inside the seat-hold `UPDATE` → `409 SALES_CLOSED`; reads derive `CLOSED` |
| **BR-FLT-07** | Cancelling a flight cancels every `HELD`/`CONFIRMED` booking on it, regardless of BR-BOOK-06. | — |
| **BR-FLT-08** | An aircraft needs at least **45 minutes** on the ground between flights (turnaround: cleaning, fuel, boarding). A flight landing at 10:00 frees the aircraft at 10:45; the window is half-open, so the next departure may be exactly 10:45. | ✅ Day 46: `flight_aircraft_occupancy()` + `AIRCRAFT_TURNAROUND_MS`, boundary pinned by the flight repository contract |
| **BR-FLT-09** | A flight has a fare for every fare class its aircraft has seats in, and for no other class. A fare is a whole number of đồng greater than 0. | ✅ Day 49A: CreateFlight → `422 MISSING_FARE` / `FARE_CLASS_NOT_ON_AIRCRAFT`; `ContractFlightFares` refused existing data that broke it; `CHK_flight_fares_amount_positive`. Kept by the application (no declarative constraint can) |
| **BR-SEAT-01** | A FlightSeat is held or booked by at most one active booking. | ✅ Day 47: one `booking_id` column per seat, claim via `FOR UPDATE SKIP LOCKED`; race tests A–E on Postgres. Day 48A: several seats per booking (UQ dropped), still one booking per seat |
| **BR-SEAT-02** | Holding several seats is all-or-nothing. | ✅ Day 48A: one statement per hold, the count/availability verdict inside the `UPDATE`'s `WHERE`; half-commit test, contract on both tiers, race tests A–B |
| **BR-SEAT-03** | A flight's FlightSeats are generated from its aircraft's layout when it is scheduled; later layout changes do not affect existing flights. | ✅ Day 47: copied in the flight's create transaction (Decision 10); existing flights backfilled |
| **BR-BOOK-01** | A booking has **1 to 9** passengers. | ✅ Day 48A: count checked first in validation (`INVALID_PASSENGER_COUNT`), `CHK_booking_passengers_position` 1–9 |
| **BR-BOOK-02** | Each passenger gets exactly one seat; a seat appears at most once in a booking. | ✅ Day 48A: `DUPLICATE_SEAT` in validation, `UQ_booking_passengers_seat`; one held seat per passenger |
| **BR-BOOK-03** | Each passenger's price is the flight's fare for that seat's class at hold time; the booking total is their sum. | ✅ Day 49A: fares read `FOR SHARE` by the hold statement, `fare_class`/`price_vnd` on each passenger, `total` derived (`bookingTotal`); race tests A–C with controls. Bookings older than Day 49A priced at migration time |
| **BR-BOOK-04** | A hold lasts **15 minutes**; an unpaid `HELD` booking then expires and releases its seats. | ✅ Day 48A: `holdExpiresAt` = now + 15 min, `CHK_bookings_hold_expiry`. Day 48B: `booking-hold-expiry-job` (60 s, batches of 50 with `SKIP LOCKED`), `idx_bookings_held_expiry`, reads derive `EXPIRED` (Decision 12); race tests A–F |
| **BR-BOOK-05** | Each booking has a unique 6-character reference from the unambiguous alphabet. | ✅ Day 48A: `generateBookingReference` (crypto), `UQ_bookings_reference` + format `CHECK`, redraw up to 5 on `ON CONFLICT DO NOTHING`; race test D |
| **BR-BOOK-06** | The owner cannot cancel a `CONFIRMED` booking within **24 hours** of departure. A `HELD` booking can be cancelled at any time until its hold expires (BR-BOOK-10). | Partly — `HELD` cancellable since Day 48A, until its hold expires since Day 48B (`409 BOOKING_EXPIRED`); the 24 h rule for `CONFIRMED` arrives with step 7 |
| **BR-BOOK-07** | A seat change keeps the same fare class, applies only to `CONFIRMED` bookings, and only while the flight is `OPEN`. | — |
| **BR-BOOK-08** | Cancelling twice is a conflict, not a no-op. | ✅ `already-cancelled` → `409` |
| **BR-BOOK-09** | In one booking request, either every passenger names a seat or none does; a mix is rejected (`422`). Without seats, the system picks the lowest free seats in row-then-letter order. | ✅ Day 48A: `MIXED_SEAT_SELECTION`; the validated input type cannot hold a mix |
| **BR-BOOK-10** | At instant `t`, a `HELD` booking is **expired** when `holdExpiresAt ≤ t` and **still valid** when `holdExpiresAt > t`. Every operation uses exactly this pair: expiry takes `≤`; cancel and payment take `>`. No instant belongs to both sides or to neither. A `HELD` booking whose deadline has passed is shown as `EXPIRED`, and cancelling it answers `409 BOOKING_EXPIRED` (Decision 12). | ✅ Day 48B: `<= $now` in the sweep, `> $now` in cancel, `isHoldLapsed` for reads; both sides pinned at the exact instant by the repository contract; race test C |
| **BR-PAY-01** | One Idempotency-Key produces at most one payment; a repeat returns the stored result. | ✅ Day 49B: `idempotency_keys` claimed by `INSERT … ON CONFLICT DO NOTHING`, response stored in phase 3's transaction (`json`, byte for byte), `Idempotent-Replayed: true`; race test A (10 requests, 1 charge) |
| **BR-PAY-02** | Reusing a key with a different request body is rejected. | ✅ Day 49B: SHA-256 fingerprint of method, path and validated body (keys sorted) → `422 IDEMPOTENCY_KEY_REUSED` |
| **BR-PAY-03** | The payment amount and currency must equal the booking total. | ✅ Day 49B: checked in phase 1 → `422 PAYMENT_AMOUNT_MISMATCH` (not stored, key released); amount captured on the payment |
| **BR-PAY-04** | Only a `HELD` booking whose hold has not expired can be paid. | ✅ Day 49B: checked in phase 1, decided by `confirmHold`'s `> now` in phase 3; lost at phase 3 → refunded; race tests C, D, C (deadline) |
| **BR-PAY-05** | A booking has at most one `SUCCEEDED` payment. | ✅ Day 49B: `UQ_payments_booking_succeeded` (partial unique index), plus one `PROCESSING` per booking (`UQ_payments_booking_processing`); race test B |
| **BR-PAY-06** | A hold that is still valid can be paid after sales close (flight `CLOSED`), until the hold expires. Sales closing stops **new** holds only. | ✅ Day 49B: neither phase reads the flight's status; unit test pays a booking whose flight closed after the hold |
| **BR-PAY-07** | A payment can only **start** while the hold has more than **60 seconds** left (`holdExpiresAt > now + 60 s`); otherwise `409 BOOKING_NOT_PAYABLE`. Confirmation still uses BR-BOOK-10 at its own instant. | ✅ Day 49B: `PAYMENT_START_MARGIN_MS`; pinned at exactly 60 s (refused) and 60 s + 1 ms (paid) |
| **BR-PAY-08** | A gateway answer of unknown outcome never fails a payment. It stays `PROCESSING` (key `IN_PROGRESS`, answer `202`) until the gateway gives a definite result for the same payment id. | ✅ Day 49C: adapter timeout → `unknown`; request `202`; the job charges the same id again, backoff ≤ 10 min, never `FAILED`; unit test + fault-injection scenarios 1–3 on Postgres |
| **BR-PAY-09** | A refund is tried at most 5 times (1, 2, 4, 8 min apart), or once when the gateway says retrying cannot help; then the payment is `REFUND_FAILED` and reported for a person. | ✅ Day 49C: `MAX_REFUND_ATTEMPTS`, `retryable` on the gateway's answer, `PAYMENT_REFUND_FAILED` + `payment_refund_needs_attention`; scenarios 5–6 |
| **BR-PAY-10** | An Idempotency-Key is kept for 24 h. Once it is gone, a repeated request is a new request, and the booking's state and BR-PAY-05 still refuse a second charge. | ✅ Day 49C: `idempotency-key-cleanup-job` deletes `COMPLETED` keys only; integration test repeats the request after cleanup → `409 BOOKING_NOT_PAYABLE`, one charge |
| **BR-AUTH-01** | Creating a booking requires a `user` JWT; the booking's owner is the token's `sub`. | ✅ Day 44 |
| **BR-AUTH-02** | A booking that exists but belongs to another account is answered exactly like one that does not exist: `404 BOOKING_NOT_FOUND`. | ✅ Day 44 — scope in every query |
| **BR-AUTH-03** | Admins can read every booking and the manifest, but do not create or pay bookings on someone's behalf. | ✅ Day 44 (bookings; manifest later) |

**Why paying after sales close is allowed (BR-PAY-06).** The customer held the seats while the flight was still open, so refusing payment minutes later would take away seats they were promised. The risk is bounded: a hold lasts at most 15 minutes and sales close 1 hour before departure, so every payable hold ends at least 45 minutes before take-off. Cancelling a `HELD` booking is likewise not restricted by departure time (BR-BOOK-06 applies to `CONFIRMED` only), because nothing has been paid and releasing seats early only helps other customers. Its only limit is the hold itself: once it has lapsed, the booking is expired, not cancelled (BR-BOOK-10).

**Why `404`, not `403`, for someone else's booking (BR-AUTH-02).** `403` confirms that the id exists. Combined with guessable references, that lets anyone probe which bookings exist. This is the same enumeration problem Day 32 avoided by giving one error for "no such email" and "wrong password". `404` costs nothing: the owner never sees it, and to everyone else the booking does not exist.

## Permissions

| Action | Guest | User | Admin |
|---|---|---|---|
| List airports, search flights, view a flight, view a seat map | ✅ | ✅ | ✅ |
| Register airports and aircraft | ❌ | ❌ | ✅ |
| Schedule, open, reschedule, cancel a flight | ❌ | ❌ | ✅ |
| Create (hold) a booking | ❌ `401` | ✅ owner = self | ❌ `403` (BR-AUTH-03) |
| List bookings | ❌ `401` | Own only | All |
| View a booking / find by reference | ❌ `401` | Own only, else `404` | ✅ |
| Pay for a booking | ❌ `401` | Own only, else `404` | ❌ `403` |
| Cancel a booking | ❌ `401` | Own only, else `404` (BR-BOOK-06 applies) | Via flight cancellation only |
| Change a seat | ❌ `401` | Own only, else `404` | ❌ `403` |
| Flight manifest, load factor, audit log | ❌ | ❌ `403` | ✅ |

## Gap vs current code

| Area | Today | Target | Breaking? |
|---|---|---|---|
| Booking ownership | ✅ Done on Day 44: `owner_account_id`, owner-scoped queries, `404` for other accounts | — | — |
| Passengers | `bookings.passenger_name` free text, one per booking | `BookingPassenger` rows, 1–9 per booking, one `name` each (Decision 11) | **Yes**: column replaced by a table; request body changes |
| Seat inventory | ✅ Done on Day 47: `flight_seats` rows, `availableSeats` derived (Decision 3), public seat map, booking shows its `seat`. `HELD` on Day 48A, expiry job on Day 48B (Decision 12) | Per-fare-class availability | — |
| Airports / aircraft | ✅ Done on Day 46: `flights` reference `airports` and `aircraft` by FK; the text codes are gone (expand → backfill → contract) | — | — |
| Flight status | ✅ Done on Day 46: stored `SCHEDULED/OPEN/CANCELLED`, `CLOSED/DEPARTED` derived (Decision 9); existing flights backfilled `OPEN` | `→ CANCELLED` with the cascade (step 9) | — |
| Booking status | ✅ Done on Day 48A/B: `HELD/CONFIRMED/EXPIRED/CANCELLED`, legacy migrated (Decision 11); `→ EXPIRED` by the job, derived on read (Decision 12) | `→ CONFIRMED` with payment (step 6) | — |
| Price | ✅ Done on Day 49A: `Money` per fare class (`flight_fares`), `VND` only, snapshot on each passenger, total derived (Decision 13); migrated expand → backfill → contract | — | — |
| Booking reference | None (UUID only) | 6-char unique reference | No (additive) |
| Payment | ✅ Done on Day 49B/C: `payments` + `idempotency_keys`, three phases (Decision 14), reconciliation and key cleanup (Decision 15) | — | — |
| Audit actor | ✅ Done on Day 44: `account/<sub>` for flight and booking writes | — | — |
| `Location` after booking | ✅ Fixed on Day 44 (`GET /api/bookings/:id`) | — | — |

**Existing data.** As decided on Day 35 for the Postgres migration, dev data is disposable: phase-D migrations may reset `booking_db` and new tables start empty. For a real system with live bookings, every **Breaking** row above would instead be an expand → backfill → contract migration:
- add the new column or table alongside the old one;
- backfill it (e.g. `active` → `CONFIRMED`, one `BookingPassenger` per `passenger_name`, owner = a placeholder "legacy" account, FlightSeats generated with N already `BOOKED` to match the counter);
- switch reads and writes over;
- only then drop the old column.

That is several deploys per change, not one migration.

## Phase D order

Ordered by dependency first, then by risk: each step builds only on what earlier steps made stable, and the largest model change comes once its prerequisites exist, not first.

| # | Feature | Stories / rules | Why here |
|---|---|---|---|
| 1 | **Booking ownership** (Day 44) | BR-AUTH-01/02, US-BOOK-02/03 | Cheap and independent of every other change, and it closes a real hole today (anyone can cancel anyone's booking). Everything after it assumes bookings have owners. |
| 2 | Airports + aircraft with seat layouts | US-REF-01/02/03, BR-REF-* | Pure additions with no impact on bookings. FlightSeats cannot exist until layouts do. |
| 3 | Flights reference airports/aircraft + flight lifecycle | US-FLT-01/02, BR-FLT-03/05/06 | Needs step 2. Introduces `OPEN`, which booking must check before step 5. The overlap rule (BR-FLT-03) is the first new concurrency guard. |
| 4 | **FlightSeat inventory + seat map** | US-SEAT-01, BR-SEAT-01/03, Decision 3 | The largest model change: `available_seats` goes away. Done once flights have aircraft (step 3), and before multi-passenger booking, so that is built once on the right model instead of on the counter and then rewritten. |
| 5 | Multi-passenger booking: reference, all-or-nothing hold, expiry job | US-BOOK-01, US-SEAT-02, BR-BOOK-01..05, BR-SEAT-02 | Needs steps 1 and 4. Highest-risk logic (multi-row OCC, the expiry job), so it gets the race tests. |
| 6a | **Fares: `Money`, price per fare class, price snapshot at hold time** (Day 49A) | US-FLT-01 (prices), BR-MONEY-01, BR-BOOK-03 | Split out of step 6 on Day 49A: payment must charge an amount that is fixed when the seats are held, and there was none — one `price_in_cents` per flight, VND or USD, nothing stored on the booking. |
| 6b | **Simulated payment with Idempotency-Key** (Day 49B) | US-PAY-01, BR-PAY-01..07 | Needs `HELD` (step 5) and the booking total (6a). Adds the payment-vs-expiry race test. Done: three phases around the gateway (Decision 14, ADR-009). |
| 6c | Payment failures: timeout, unknown outcome, reconciliation (Day 49C) | BR-PAY-08..10 | Needs 6b. The hard failure modes get their own day instead of being squeezed into the happy path. Done: reconciliation job, refunds out of the request, key cleanup (Decision 15, ADR-010). |
| 7 | Cancellation policy + seat change | US-BOOK-05/06, BR-BOOK-06/07 | Needs `CONFIRMED` (step 6). |
| 8 | Flight search + details with availability | US-FLT-04/05 | Read-only. Best done once availability is derived from FlightSeats (step 4) and status exists (step 3). |
| 9 | Flight cancellation cascade | US-OPS-01, BR-FLT-07 | Touches every booking state, so it comes after all of them exist. (Automatic close/depart, US-OPS-02, needs no job since Day 46: those statuses are derived, Decision 9.) |
| 10 | Admin: manifest, load factor, audit query | US-ADM-* | Read-only reports over everything above. |

US-FLT-03 (reschedule) and US-BOOK-04 (find by reference) are Should items that slot into steps 3 and 5 if time allows.

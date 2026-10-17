# Domain Model

How the booking domain works inside: entities, aggregates and the invariants they protect, lifecycles, the business-rule catalogue, and who may do what. Terms are defined in the [glossary](./scope.md#glossary). The stories these rules serve are in [scope.md](./scope.md).

This document describes the **target** model for phase D, not what the code does today. [Gap vs current code](#gap-vs-current-code) lists the difference.

## Entities and value objects

**Value objects** have no identity of their own; two with equal fields are the same value.

| Value object | Fields | Notes |
|---|---|---|
| `Money` | `amountMinor: integer`, `currency: "VND"` | Integer in the currency's smallest unit, never a float (`0.1 + 0.2 !== 0.3`). One currency today (BR-MONEY-01), but the code is stored so a second one is a data change. |
| `SeatPosition` | `row: integer ≥ 1`, `letter: "A"–"K"` | Rendered `12A`. Unique within one SeatLayout. |
| `BookingReference` | 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` | No `0/O`, `1/I` because people read it aloud (BR-BOOK-05). |

**Entities** have an identity (UUID) that stays the same while their data changes.

| Entity | Key attributes |
|---|---|
| `Airport` | `id`, `code` (IATA, unique), `name`, `city`, `timeZone` (IANA name) |
| `Aircraft` | `id`, `registration`, `model` |
| `Seat` | `aircraftId`, `position: SeatPosition`, `fareClass` |
| `Flight` | `id`, `flightNumber`, `originAirportId`, `destinationAirportId`, `aircraftId`, `departureAt`, `arrivalAt`, `status`, `fares: { ECONOMY: Money, BUSINESS: Money }` |
| `FlightSeat` | `flightId` + `position` (composite key, no surrogate id), `fareClass`, `status`, `bookingId?` (no version column: `status` itself is the guard, ADR-004; see Decision 10) |
| `Booking` | `id`, `reference`, `flightId`, `ownerAccountId`, `status`, `total: Money`, `holdExpiresAt`, `createdAt` |
| `BookingPassenger` | `bookingId`, `position` (1–9, request order), `name`, `seat: SeatPosition` (a display copy; the truth is `FlightSeat.bookingId`, Decision 11), `fareClass`, `price: Money` (snapshot) |
| `Payment` | `id`, `bookingId`, `idempotencyKey`, `requestHash`, `amount: Money`, `status`, `createdAt` |

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
| **Flight** | Flight + its FlightSeats (seat inventory) | Arrival after departure, origin ≠ destination (BR-FLT-01/02); status follows the lifecycle (BR-FLT-05); **a FlightSeat is held or booked by at most one active Booking** (BR-SEAT-01); a multi-seat hold is all-or-nothing (BR-SEAT-02) |
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
VND has no subunit in practice, so `amountMinor` is whole đồng. `Money` still carries `currency`, so a second currency later means new data plus conversion rules, not a schema redesign. Multiple currencies are in [Won't](./scope.md#wont).

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

**Lock order across hold, cancel and expiry.** All three touch a booking and its seats; each takes its locks in the same direction, so two of them cannot wait on each other in a circle:

| Operation | 1st lock | 2nd lock | Seats locked in |
|---|---|---|---|
| Hold, seats chosen (Day 48A) | — (booking is new) | Seats, then a share lock on the flight | `(row, letter)` order |
| Hold, system-picked (Day 48A) | — | Seats with `SKIP LOCKED` (never waits) | `(row, letter)` order |
| Cancel | The booking row (conditional `UPDATE`) | The booking's seats | `(row, letter)` order, from Day 48B |
| Expire (job) | The due booking rows, `SKIP LOCKED` | Their seats | `(row, letter)` order, from Day 48B |

Found while planning this day: until Day 48B, cancel released seats with a plain `UPDATE … WHERE booking_id = $1`, which locks them in whatever order the scan returns, not `(row, letter)`. A chosen-seat hold on `[12A, 12B]` could hold 12A and wait for 12B while a cancel of the booking holding both had locked 12B and waits for 12A: a deadlock, which Postgres resolves by failing one of them (`40P01`). Release therefore locks the seats first, `ORDER BY "flight_id", "row", "letter" FOR UPDATE`, and only then updates them; cancel and expiry share that shape (`releaseSeatsOf`). Race test E forces the interleaving with a gate transaction on 12A: a release locking 12B first deadlocked 5 rounds out of 5; the real cancel and sweep, 0. Removing the `ORDER BY` altogether is not caught today — the physical order happens to be `(row, letter)` — the same as the hold's `ORDER BY` (Day 48A): the clause is the guarantee, the plan is not.

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

**Race: payment and expiry at the same second.** `HELD → CONFIRMED` and `HELD → EXPIRED` can run at the same moment. Both are conditional `UPDATE bookings SET status = … WHERE id = $1 AND status = 'HELD' AND holdExpiresAt (> | ≤) now`, the ADR-004 pattern already used by `cancel()`, with the BR-BOOK-10 boundary. Postgres row locking makes the second writer re-check the condition against the first writer's committed row, so exactly one wins. If expiry wins, the payment's update affects 0 rows, the payment use case returns `booking-not-payable`, and it must not record a `SUCCEEDED` payment (create the payment row in the same transaction, after the booking update succeeds). This gets a race test on Postgres, like Day 39's.

**Race: cancel and expiry at the same second (Day 48B).** The same shape, decided by BR-BOOK-10. Cancel updates `WHERE status = 'HELD' AND holdExpiresAt > now`; expiry updates `WHERE status = 'HELD' AND holdExpiresAt ≤ now`. For one `now` the two conditions never both hold, so at most one can match. When the two operations read the clock at slightly different instants, both may match in principle; the row lock still lets only the first writer through, and the second re-checks `status = 'HELD'` against the committed row and matches nothing. Either way the booking gets exactly one end, its seats are released once, and there is one audit entry and one event.

### Payment

| From | To | Triggered by | Condition | Side effects |
|---|---|---|---|---|
| — | `SUCCEEDED` | User (US-PAY-01), simulated success | Booking moved `HELD → CONFIRMED` in the same transaction | — |
| — | `FAILED` | User, simulated decline | — | Booking stays `HELD` |

- **Terminal:** both. A retry with a new key is a new Payment. A retry with the same key returns the stored one (BR-PAY-01).
- There is no `PENDING` state: the simulator answers synchronously. A real gateway would need one. That is noted, not built ([Won't](./scope.md#wont)).

## Business rules

Numbers are fixed here and nowhere else. Code constants and tests reference these IDs.

**Existing** = already enforced in today's code (validation, DB constraint or use case), to be carried over.

| ID | Rule | Existing |
|---|---|---|
| **BR-MONEY-01** | Amounts are integers in minor units with a currency code; the only accepted currency is `VND`. | Partly — `priceInCents` integer; `VND`/`USD` both accepted |
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
| **BR-SEAT-01** | A FlightSeat is held or booked by at most one active booking. | ✅ Day 47: one `booking_id` column per seat, claim via `FOR UPDATE SKIP LOCKED`; race tests A–E on Postgres. Day 48A: several seats per booking (UQ dropped), still one booking per seat |
| **BR-SEAT-02** | Holding several seats is all-or-nothing. | ✅ Day 48A: one statement per hold, the count/availability verdict inside the `UPDATE`'s `WHERE`; half-commit test, contract on both tiers, race tests A–B |
| **BR-SEAT-03** | A flight's FlightSeats are generated from its aircraft's layout when it is scheduled; later layout changes do not affect existing flights. | ✅ Day 47: copied in the flight's create transaction (Decision 10); existing flights backfilled |
| **BR-BOOK-01** | A booking has **1 to 9** passengers. | ✅ Day 48A: count checked first in validation (`INVALID_PASSENGER_COUNT`), `CHK_booking_passengers_position` 1–9 |
| **BR-BOOK-02** | Each passenger gets exactly one seat; a seat appears at most once in a booking. | ✅ Day 48A: `DUPLICATE_SEAT` in validation, `UQ_booking_passengers_seat`; one held seat per passenger |
| **BR-BOOK-03** | Each passenger's price is the flight's fare for that seat's class at hold time; the booking total is their sum. | — |
| **BR-BOOK-04** | A hold lasts **15 minutes**; an unpaid `HELD` booking then expires and releases its seats. | ✅ Day 48A: `holdExpiresAt` = now + 15 min, `CHK_bookings_hold_expiry`. Day 48B: `booking-hold-expiry-job` (60 s, batches of 50 with `SKIP LOCKED`), `idx_bookings_held_expiry`, reads derive `EXPIRED` (Decision 12); race tests A–F |
| **BR-BOOK-05** | Each booking has a unique 6-character reference from the unambiguous alphabet. | ✅ Day 48A: `generateBookingReference` (crypto), `UQ_bookings_reference` + format `CHECK`, redraw up to 5 on `ON CONFLICT DO NOTHING`; race test D |
| **BR-BOOK-06** | The owner cannot cancel a `CONFIRMED` booking within **24 hours** of departure. A `HELD` booking can be cancelled at any time until its hold expires (BR-BOOK-10). | Partly — `HELD` cancellable since Day 48A, until its hold expires since Day 48B (`409 BOOKING_EXPIRED`); the 24 h rule for `CONFIRMED` arrives with step 7 |
| **BR-BOOK-07** | A seat change keeps the same fare class, applies only to `CONFIRMED` bookings, and only while the flight is `OPEN`. | — |
| **BR-BOOK-08** | Cancelling twice is a conflict, not a no-op. | ✅ `already-cancelled` → `409` |
| **BR-BOOK-09** | In one booking request, either every passenger names a seat or none does; a mix is rejected (`422`). Without seats, the system picks the lowest free seats in row-then-letter order. | ✅ Day 48A: `MIXED_SEAT_SELECTION`; the validated input type cannot hold a mix |
| **BR-BOOK-10** | At instant `t`, a `HELD` booking is **expired** when `holdExpiresAt ≤ t` and **still valid** when `holdExpiresAt > t`. Every operation uses exactly this pair: expiry takes `≤`; cancel and payment take `>`. No instant belongs to both sides or to neither. A `HELD` booking whose deadline has passed is shown as `EXPIRED`, and cancelling it answers `409 BOOKING_EXPIRED` (Decision 12). | ✅ Day 48B: `<= $now` in the sweep, `> $now` in cancel, `isHoldLapsed` for reads; both sides pinned at the exact instant by the repository contract; race test C |
| **BR-PAY-01** | One Idempotency-Key produces at most one payment; a repeat returns the stored result. | — |
| **BR-PAY-02** | Reusing a key with a different request body is rejected. | — |
| **BR-PAY-03** | The payment amount and currency must equal the booking total. | — |
| **BR-PAY-04** | Only a `HELD` booking whose hold has not expired can be paid. | — |
| **BR-PAY-05** | A booking has at most one `SUCCEEDED` payment. | — |
| **BR-PAY-06** | A hold that is still valid can be paid after sales close (flight `CLOSED`), until the hold expires. Sales closing stops **new** holds only. | — |
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
| Price | One `price_in_cents` per flight; `VND` or `USD` | `Money` per fare class; `VND` only; snapshot on booking | **Yes**: column rename/split; `USD` dropped |
| Booking reference | None (UUID only) | 6-char unique reference | No (additive) |
| Payment | None | `payments` table, Idempotency-Key | No (additive) |
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
| 6 | Simulated payment with Idempotency-Key | US-PAY-01, BR-PAY-* | Needs `HELD` (step 5). Adds the payment-vs-expiry race test. |
| 7 | Cancellation policy + seat change | US-BOOK-05/06, BR-BOOK-06/07 | Needs `CONFIRMED` (step 6). |
| 8 | Flight search + details with availability | US-FLT-04/05 | Read-only. Best done once availability is derived from FlightSeats (step 4) and status exists (step 3). |
| 9 | Flight cancellation cascade | US-OPS-01, BR-FLT-07 | Touches every booking state, so it comes after all of them exist. (Automatic close/depart, US-OPS-02, needs no job since Day 46: those statuses are derived, Decision 9.) |
| 10 | Admin: manifest, load factor, audit query | US-ADM-* | Read-only reports over everything above. |

US-FLT-03 (reschedule) and US-BOOK-04 (find by reference) are Should items that slot into steps 3 and 5 if time allows.

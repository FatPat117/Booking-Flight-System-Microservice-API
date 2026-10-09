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
| `Airport` | `code` (IATA, natural key), `name`, `city` |
| `Aircraft` | `id`, `registration`, `model` |
| `Seat` | `aircraftId`, `position: SeatPosition`, `fareClass` |
| `Flight` | `id`, `flightNumber`, `originCode`, `destinationCode`, `aircraftId`, `departureAt`, `arrivalAt`, `status`, `fares: { ECONOMY: Money, BUSINESS: Money }` |
| `FlightSeat` | `id`, `flightId`, `position`, `fareClass`, `status`, `bookingId?` (no version column: `status` itself is the OCC guard, ADR-004) |
| `Booking` | `id`, `reference`, `flightId`, `ownerAccountId`, `status`, `total: Money`, `holdExpiresAt`, `createdAt` |
| `BookingPassenger` | `bookingId`, `firstName`, `lastName`, `flightSeatId`, `fareClass`, `price: Money` (snapshot) |
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
| **Airport** | Airport | Code is 3 uppercase letters and unique (BR-REF-01) |
| **Aircraft** | Aircraft + its Seats | Registration unique (BR-REF-02); seat positions unique, every seat has a fare class (BR-REF-03) |
| **Flight** | Flight + its FlightSeats (seat inventory) | Arrival after departure, origin ≠ destination (BR-FLT-01/02); status follows the lifecycle (BR-FLT-05); **a FlightSeat is held or booked by at most one active Booking** (BR-SEAT-01); a multi-seat hold is all-or-nothing (BR-SEAT-02) |
| **Booking** | Booking + BookingPassengers | Owned by exactly one account (BR-AUTH-01); 1–9 passengers, one distinct seat each (BR-BOOK-01/02); prices are a snapshot taken at hold time (BR-BOOK-03); status follows the lifecycle |
| **Payment** | Payment | One idempotency key ⇒ one payment (BR-PAY-01/02); amount equals the booking total (BR-PAY-03) |

### Decisions

**1. Seat status belongs to the Flight side (the seat inventory), not to Booking.**
"A seat is sold at most once" is a rule about the *flight's* inventory: two different bookings compete for it. Putting status on `FlightSeat` makes the rule one conditional `UPDATE … WHERE status = 'AVAILABLE'` per seat (ADR-004), the same OCC shape as today's `reserveSeat`. Putting it inside Booking would leave nothing but a database unique constraint across bookings, and the Flight side would not know which seats are sold, though it needs that for the seat map, the load factor and cascading cancellation.

**2. A multi-seat hold is all-or-nothing (BR-SEAT-02).**
A family that cannot sit together usually does not want a partial booking. A partial hold would also need a "short of seats" booking state. Mechanically, all seats are held in **one transaction** with one conditional `UPDATE` per seat. If any update affects 0 rows, the use case returns `seats-unavailable` with the losing positions and the transaction rolls back, releasing the seats it had already claimed. The ADR-004 addendum applies: once a miss is detected, no further query runs in that transaction.

**3. `availableSeats` becomes derived, not stored.**
Today `flights.available_seats` is the inventory. Once FlightSeats exist, a stored counter would be a second copy of the truth that can drift. Availability is computed as a count of `FlightSeat` rows with `status = 'AVAILABLE'` (per fare class). The existing `reserveSeat`/`releaseSeat` counter logic is replaced, not kept alongside.

**4. Booking prices are a snapshot.**
`BookingPassenger.price` and `Booking.total` are copied from the flight's fares when the hold is created. If an admin changes a fare afterwards, the customer still pays the price they were shown. That is the only defensible answer to "which price does the customer pay?", and it keeps Payment independent of later fare edits.

**5. One currency (VND), stored as integer minor units.**
VND has no subunit in practice, so `amountMinor` is whole đồng. `Money` still carries `currency`, so a second currency later means new data plus conversion rules, not a schema redesign. Multiple currencies are in [Won't](./scope.md#wont).

### What happens to these boundaries in phase F

When Flight and Booking become separate services with separate databases, "hold seats" runs in the **Flight service**, which owns the inventory. Booking then cannot hold seats and create itself in one transaction any more. It will need a request to the Flight service plus compensation when a later step fails: a saga, or at minimum a reservation with its own expiry on the Flight side. This is accepted: the boundary was chosen so that the *invariant* (BR-SEAT-01) stays inside one service. Only the *workflow* becomes distributed, which is the easier half to make eventually consistent. Today's single transaction across both aggregates is a phase-D convenience, and it is written here so nobody mistakes it for a permanent guarantee.

## Lifecycles

### Flight

| From | To | Triggered by | Condition | Side effects |
|---|---|---|---|---|
| — | `SCHEDULED` | Admin (US-FLT-01) | BR-FLT-01/02/03/04 | One FlightSeat per Seat, all `AVAILABLE`; `flight-created` |
| `SCHEDULED` | `OPEN` | Admin (US-FLT-02) | Departure more than 1 h away | Bookable |
| `OPEN` | `CLOSED` | System job (US-OPS-02) | Now ≥ departure − 1 h (BR-FLT-06) | No new holds; existing holds may still be paid until they expire |
| `CLOSED` | `DEPARTED` | System job | Now ≥ departure | Remaining `HELD` bookings expire |
| `SCHEDULED` / `OPEN` / `CLOSED` | `CANCELLED` | Admin (US-OPS-01) | Not departed | Every `HELD`/`CONFIRMED` booking → `CANCELLED` (reason `FLIGHT_CANCELLED`, ignores BR-BOOK-06); one `booking-cancelled` per booking; `flight-cancelled` |

- **Terminal:** `DEPARTED`, `CANCELLED`.
- **Forbidden:** anything out of a terminal state; `OPEN → SCHEDULED`; `CLOSED → OPEN` (re-opening after closing would bypass BR-FLT-06).
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

### Booking

| From | To | Triggered by | Condition | Side effects |
|---|---|---|---|---|
| — | `HELD` | User (US-BOOK-01) | BR-BOOK-01/02, BR-FLT-06, BR-SEAT-02 | Seats `HELD`; `holdExpiresAt` = now + 15 min; `booking-created` |
| `HELD` | `CONFIRMED` | Payment succeeds (US-PAY-01) | `status = 'HELD'` **and** `holdExpiresAt > now` | Seats `BOOKED`; `booking-confirmed` |
| `HELD` | `EXPIRED` | System job (US-SEAT-02) | `status = 'HELD'` **and** `holdExpiresAt ≤ now` | Seats `AVAILABLE`; `booking-expired` |
| `HELD` | `CANCELLED` | Owner (US-BOOK-05) or flight cancellation | — | Seats `AVAILABLE`; `booking-cancelled` |
| `CONFIRMED` | `CANCELLED` | Owner (US-BOOK-05) | Departure more than 24 h away (BR-BOOK-06) | Seats `AVAILABLE`; `booking-cancelled` |
| `CONFIRMED` | `CANCELLED` | Flight cancellation (US-OPS-01) | — (window does not apply, BR-FLT-07) | Seats `UNAVAILABLE`; `booking-cancelled` with reason |

- **Terminal:** `EXPIRED`, `CANCELLED`. A departed flight's `CONFIRMED` bookings simply stay `CONFIRMED`; "flown" is not modelled.
- **Forbidden:** `CANCELLED → CONFIRMED`, `EXPIRED → CONFIRMED` (a late payment must not resurrect a booking whose seats may already be resold), `CONFIRMED → HELD`.

**Race: payment and expiry at the same second.** `HELD → CONFIRMED` and `HELD → EXPIRED` can run at the same moment. Both are conditional `UPDATE bookings SET status = … WHERE id = $1 AND status = 'HELD' AND holdExpiresAt (> | ≤) now()`, the ADR-004 pattern already used by `cancel()`. Postgres row locking makes the second writer re-check the condition against the first writer's committed row, so exactly one wins. If expiry wins, the payment's update affects 0 rows, the payment use case returns `booking-not-payable`, and it must not record a `SUCCEEDED` payment (create the payment row in the same transaction, after the booking update succeeds). This gets a race test on Postgres, like Day 39's.

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
| **BR-REF-01** | An airport code is exactly 3 uppercase letters and unique. | Format only (`flights.origin` text) |
| **BR-REF-02** | An aircraft registration is unique. | — |
| **BR-REF-03** | Seat positions are unique within a layout, and every seat has a fare class. | — |
| **BR-FLT-01** | Arrival is after departure. | ✅ validation + `CHECK` |
| **BR-FLT-02** | Origin and destination differ. | ✅ validation + `CHECK` |
| **BR-FLT-03** | An aircraft never operates two flights whose `[departureAt, arrivalAt)` windows overlap. | — (concurrent admins can race; needs a DB-level guard, e.g. an exclusion constraint) |
| **BR-FLT-04** | Flight number + departure instant is unique. | ✅ `UNIQUE` |
| **BR-FLT-05** | Flight status changes only along the Flight lifecycle table. | — |
| **BR-FLT-06** | Seats can be held only while the flight is `OPEN`; sales close **1 hour** before departure. | — |
| **BR-FLT-07** | Cancelling a flight cancels every `HELD`/`CONFIRMED` booking on it, regardless of BR-BOOK-06. | — |
| **BR-SEAT-01** | A FlightSeat is held or booked by at most one active booking. | Counter version ✅ (`available_seats > 0` OCC) |
| **BR-SEAT-02** | Holding several seats is all-or-nothing. | — |
| **BR-SEAT-03** | A flight's FlightSeats are generated from its aircraft's layout when it is scheduled; later layout changes do not affect existing flights. | — |
| **BR-BOOK-01** | A booking has **1 to 9** passengers. | — (exactly 1 today) |
| **BR-BOOK-02** | Each passenger gets exactly one seat; a seat appears at most once in a booking. | — |
| **BR-BOOK-03** | Each passenger's price is the flight's fare for that seat's class at hold time; the booking total is their sum. | — |
| **BR-BOOK-04** | A hold lasts **15 minutes**; an unpaid `HELD` booking then expires and releases its seats. | — |
| **BR-BOOK-05** | Each booking has a unique 6-character reference from the unambiguous alphabet. | — |
| **BR-BOOK-06** | The owner cannot cancel a `CONFIRMED` booking within **24 hours** of departure. A `HELD` booking can always be cancelled. | — (cancel has no time rule today) |
| **BR-BOOK-07** | A seat change keeps the same fare class, applies only to `CONFIRMED` bookings, and only while the flight is `OPEN`. | — |
| **BR-BOOK-08** | Cancelling twice is a conflict, not a no-op. | ✅ `already-cancelled` → `409` |
| **BR-PAY-01** | One Idempotency-Key produces at most one payment; a repeat returns the stored result. | — |
| **BR-PAY-02** | Reusing a key with a different request body is rejected. | — |
| **BR-PAY-03** | The payment amount and currency must equal the booking total. | — |
| **BR-PAY-04** | Only a `HELD` booking whose hold has not expired can be paid. | — |
| **BR-PAY-05** | A booking has at most one `SUCCEEDED` payment. | — |
| **BR-AUTH-01** | Creating a booking requires a `user` JWT; the booking's owner is the token's `sub`. | — (no auth today) |
| **BR-AUTH-02** | A booking that exists but belongs to another account is answered exactly like one that does not exist: `404 BOOKING_NOT_FOUND`. | — |
| **BR-AUTH-03** | Admins can read every booking and the manifest, but do not create or pay bookings on someone's behalf. | — |

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
| Booking ownership | No owner; `POST …/bookings` and `DELETE /api/bookings/:id` need no token | `ownerAccountId` from JWT `sub`; owner-only access with `404` | **Yes**: API now requires a token; existing rows have no owner |
| Passengers | `bookings.passenger_name` free text, one per booking | `BookingPassenger` rows, 1–9 per booking, first/last name | **Yes**: column replaced by a table; request body changes |
| Seat inventory | `flights.available_seats` counter; `reserveSeat`/`releaseSeat` | `FlightSeat` rows; availability derived (Decision 3) | **Yes**: counter removed; `BookingRepository` port changes |
| Airports / aircraft | `origin`/`destination` free 3-letter text; no aircraft | FK to `airports`; `aircraft_id` FK; layouts | **Yes**: new required columns on `flights` |
| Flight status | None (every flight is bookable) | `SCHEDULED/OPEN/CLOSED/DEPARTED/CANCELLED` | **Yes**: new column; existing flights need a status |
| Booking status | `active` / `cancelled` (lowercase) | `HELD/CONFIRMED/EXPIRED/CANCELLED` | **Yes**: value set and `CHECK` change; `active` ≈ `CONFIRMED` |
| Price | One `price_in_cents` per flight; `VND` or `USD` | `Money` per fare class; `VND` only; snapshot on booking | **Yes**: column rename/split; `USD` dropped |
| Booking reference | None (UUID only) | 6-char unique reference | No (additive) |
| Payment | None | `payments` table, Idempotency-Key | No (additive) |
| Audit actor | `admin_api_key/admin`, `passenger/anonymous` | `account/<sub>` with role | No (new values; old rows stay as written) |
| `Location` after booking | Points to a route that does not exist | `GET /api/bookings/:id` exists | No (fix) |

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
| 9 | Flight cancellation cascade + automatic close/depart | US-OPS-01/02, BR-FLT-07 | Touches every booking state, so it comes after all of them exist. |
| 10 | Admin: manifest, load factor, audit query | US-ADM-* | Read-only reports over everything above. |

US-FLT-03 (reschedule) and US-BOOK-04 (find by reference) are Should items that slot into steps 3 and 5 if time allows.

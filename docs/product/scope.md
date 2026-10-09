# Product Scope

What the booking system does, and for whom. How it works inside (entities, aggregates, lifecycles, rule catalogue) is in [domain-model.md](./domain-model.md). When in phase D each part is built is in [roadmap.md](../roadmap.md).

Story IDs (`US-*`) are referenced by tests and ADRs. Business-rule IDs (`BR-*`) are defined in [domain-model.md](./domain-model.md#business-rules).

## Actors

| Actor | Who | Wants to |
|---|---|---|
| **Guest** | Anyone, not logged in | Find a flight and see what it costs and which seats are free, before committing to an account |
| **User** | Logged-in account, JWT `role=user` | Book seats for themselves and others, pay, and manage (view, cancel, change) their own bookings |
| **Admin** | Logged-in account, JWT `role=admin` | Maintain reference data and the flight schedule, cancel flights, and see who is flying |
| **System** | Background jobs and event consumers | Enforce time-based rules nobody clicks for (hold expiry, sales closing, departure) and react to events |

## Glossary

One concept, one name, used the same way in docs, code, API and tests.

| Term (code name) | Definition |
|---|---|
| **Airport** | A place flights depart from and arrive at, identified by its 3-letter IATA code (`SGN`, `HAN`). |
| **Aircraft** | A physical airplane, identified by its registration (`VN-A321`), with exactly one SeatLayout. |
| **SeatLayout** | The fixed set of Seats an Aircraft has. Defined once per aircraft and shared by every flight it operates. |
| **Seat** | A position in a SeatLayout (`12A` on aircraft `VN-A321`), with a FareClass. It has **no** availability, because it exists independently of any flight. |
| **SeatPosition** | The `row` + `letter` value identifying a Seat within a layout (`12A`). |
| **Flight** | One scheduled operation of an Aircraft from an origin Airport to a destination Airport at a departure time (`VN123` on 2026-11-10 08:00). |
| **FlightSeat** | A Seat **on one specific Flight**. This is the unit that is held, booked and released. `12A` can be free on one flight and sold on the next. |
| **FareClass** | The price bucket a Seat belongs to: `ECONOMY` or `BUSINESS`. A Flight sets one price per FareClass. |
| **Money** | An amount as an integer in the currency's minor unit, plus an ISO 4217 currency code. Never a floating-point number. |
| **Account** | Someone who can log in (owned by the Identity service). An Account **owns** Bookings, but is not necessarily on the plane. |
| **Passenger** | A person who flies. They may have no Account (a child, a relative). Identified on a booking by name only. |
| **Booking** | One Account's purchase of seats on one Flight for 1–9 Passengers, with a lifecycle (`HELD` → `CONFIRMED` …). |
| **BookingPassenger** | One Passenger within one Booking, assigned exactly one FlightSeat. |
| **BookingReference** (PNR) | A short, human-readable code (`K7Q4PZ`) identifying a Booking to people. The Booking id stays the technical identity. |
| **SeatHold** | The time-limited claim a `HELD` Booking has on its FlightSeats (15 minutes). Not a separate record: it is the FlightSeat's `HELD` status plus the Booking's `holdExpiresAt`. |
| **Payment** | One attempt to pay a held Booking's total, identified by its Idempotency-Key. Simulated: no real gateway. |
| **Idempotency-Key** | A client-generated key sent with a payment request so that retrying the same request never charges twice. |
| **Manifest** | The list of confirmed Passengers on a Flight, with their seats. |
| **Load factor** | Booked FlightSeats ÷ total FlightSeats on a Flight. |

**Seat and FlightSeat are different things.** One aircraft flies many flights, so availability can only live on FlightSeat. Code never calls a FlightSeat a "seat" in a name, column or route.

**Account and Passenger are different things.** One Account books for a whole family, so a Booking has one owner (`ownerAccountId`) and many BookingPassengers. Merging the two makes multi-passenger booking impossible to model. It is also why the JWT role is `user`, not `passenger`.

## User stories

Priority uses MoSCoW: **Must** (minimum complete system), **Should**, **Could**. **Won't** items are listed [at the end](#wont). Every Must story has at least one success and one failure criterion.

### Reference data

**US-REF-01 (Must): Register an airport**
As an admin, I want to register airports so flights can be scheduled between them.
- Given no airport `DAD` exists, when I register `DAD` "Da Nang International", then it is created (`201`).
- Given `DAD` already exists, when I register `DAD` again, then I get `409 AIRPORT_ALREADY_EXISTS`.
- Given the code `DA1`, when I register it, then I get `422`, because a code is exactly 3 letters (BR-REF-01).

**US-REF-02 (Must): Register an aircraft with its seat layout**
As an admin, I want to register an aircraft together with its seat layout so flights it operates get a seat map.
- Given registration `VN-A321` is unused, when I register it with 30 economy and 8 business seats, then it is created with 38 Seats.
- Given a layout listing `12A` twice, when I register it, then I get `422` naming `12A` (BR-REF-03).
- Given `VN-A321` already exists, when I register it again, then I get `409 AIRCRAFT_ALREADY_EXISTS`.

**US-REF-03 (Should): List airports.** As a guest, I want to list airports so I can pick an origin and a destination.

### Flights

**US-FLT-01 (Must): Schedule a flight**
As an admin, I want to schedule a flight between two airports on a specific aircraft, with a price per fare class.
- Given airports `SGN`, `HAN` and aircraft `VN-A321` exist, when I schedule `VN123` SGN→HAN departing 2026-11-10 08:00 arriving 10:10 with economy 1,500,000 VND and business 4,000,000 VND, then the flight is `SCHEDULED` and one FlightSeat is created per Seat in the layout, all `AVAILABLE`.
- Given origin and destination are both `SGN`, then `422` (BR-FLT-02).
- Given arrival is before departure, then `422` (BR-FLT-01).
- Given `VN-A321` already operates a flight whose time window overlaps, then `409 AIRCRAFT_UNAVAILABLE` (BR-FLT-03).
- Given `VN123` already departs at that exact instant, then `409 FLIGHT_ALREADY_EXISTS` (existing rule, kept).

**US-FLT-02 (Must): Open a flight for sale**
As an admin, I want to open a scheduled flight for sale.
- Given `VN123` is `SCHEDULED` and departs in 3 days, when I open it, then it becomes `OPEN`.
- Given `VN123` is `CANCELLED`, when I open it, then `409 INVALID_FLIGHT_STATUS` (BR-FLT-05).

**US-FLT-03 (Should): Reschedule a flight**
As an admin, I want to change a flight's departure and arrival times.
- Given `VN123` is `OPEN` with confirmed bookings, when I move departure by 2 hours, then the times change, bookings keep their seats, and a `flight-rescheduled` event is emitted.
- Given `VN123` is `DEPARTED`, then `409 INVALID_FLIGHT_STATUS`.

**US-FLT-04 (Must): Search flights**
As a guest, I want to search flights by origin, destination and date.
- Given two `OPEN` flights SGN→HAN on 2026-11-10 and one `CANCELLED`, when I search SGN→HAN on that date, then I see the two open flights ordered by departure time, each with its price per fare class and its number of available seats.
- Given the date `2026-02-30`, then `422`.
- Given no matching flights, then `200` with an empty list (not `404`).

**US-FLT-05 (Must): View flight details**
As a guest, I want to see one flight's route, times, status, prices and available seats per fare class.
- Given `VN123` exists, then I get its details (`200`).
- Given an unknown id, then `404 FLIGHT_NOT_FOUND`.

### Seats

**US-SEAT-01 (Must): View the seat map**
As a guest, I want to see a flight's seat map so I can choose seats.
- Given `VN123` is `OPEN`, then I see every seat position with its fare class and its status: `AVAILABLE`, `HELD` or `BOOKED`. Showing `HELD` separately tells a client the seat may free up within 15 minutes, so a frontend can grey it out differently and avoid sending holds that are certain to fail. Who holds it and when the hold expires are not exposed.
- The map is a snapshot. A seat shown `AVAILABLE` can be taken a moment later, and the hold request itself (BR-SEAT-01/02) is what decides, not the map.
- Given an unknown flight, then `404 FLIGHT_NOT_FOUND`.

**US-SEAT-02 (Must): Held seats are released when the hold expires**
As the system, I want to expire unpaid holds so abandoned bookings don't block seats.
- Given a booking was `HELD` 16 minutes ago and never paid, when the expiry job runs, then the booking becomes `EXPIRED` and its seats become `AVAILABLE` (BR-BOOK-04).
- Given the booking was paid at minute 14, when the expiry job runs at minute 16, then nothing changes, because the booking is already `CONFIRMED`.

### Bookings

**US-BOOK-01 (Must): Book several passengers in one go**
As a logged-in user, I want to book seats for several passengers on one flight at once, so my family flies together.
- Given `VN123` is `OPEN` and `12A`, `12B` are available, when I book 2 passengers on `12A`, `12B`, then the booking is `HELD`, both seats are held for 15 minutes, I am its owner, and I receive a booking reference.
- Given `12B` was just held by someone else, when I book `12A`, `12B`, then **no** seat is held and I get `409 SEATS_UNAVAILABLE` listing `12B` (all-or-nothing, BR-SEAT-02).
- Given 10 passengers, then `422` (BR-BOOK-01).
- Given the same seat twice in one request, then `422` (BR-BOOK-02).
- Given `VN123` departs in 50 minutes, then `409 SALES_CLOSED` (BR-FLT-06).
- Given no JWT, then `401`.

**US-BOOK-02 (Must): List my bookings**
As a user, I want to list my bookings, newest first.
- Given I own 2 bookings and another account owns 3, then I see exactly my 2.
- Given no JWT, then `401`.

**US-BOOK-03 (Must): View one of my bookings**
As a user, I want to view a booking's passengers, seats, status, total price and hold deadline.
- Given I own booking `b1`, then I get it (`200`).
- Given `b1` belongs to another account, then `404 BOOKING_NOT_FOUND`, the same response as for an id that does not exist (BR-AUTH-02).

**US-BOOK-04 (Should): Find a booking by its reference**
As a user, I want to open a booking by its reference (`K7Q4PZ`) because that is what I wrote down.
- Given I own `K7Q4PZ`, then I get the booking.
- Given `K7Q4PZ` is someone else's, then `404` (BR-AUTH-02).

**US-BOOK-05 (Must): Cancel my booking**
As a user, I want to cancel my booking and free its seats.
- Given my `CONFIRMED` booking departs in 3 days, when I cancel it, then it becomes `CANCELLED`, its seats become `AVAILABLE`, and a `booking-cancelled` event is emitted.
- Given my booking is `HELD`, when I cancel it, then it becomes `CANCELLED` and its seats are released immediately.
- Given departure is in 20 hours, then `409 CANCELLATION_WINDOW_CLOSED` (BR-BOOK-06).
- Given it is already `CANCELLED`, then `409 BOOKING_ALREADY_CANCELLED` (existing rule, kept).
- Given it belongs to another account, then `404` (BR-AUTH-02).

**US-BOOK-06 (Should): Change a passenger's seat**
As a user, I want to move a passenger in my confirmed booking to another available seat of the same fare class.
- Given `14C` is available and economy, when I move a passenger from `12A` to `14C`, then `14C` becomes `BOOKED` and `12A` becomes `AVAILABLE`, in one transaction.
- Given `14C` was just taken, then `409 SEATS_UNAVAILABLE` and the passenger stays on `12A`.
- Given `2A` is business, then `422 FARE_CLASS_MISMATCH` (BR-BOOK-07).

### Payment

**US-PAY-01 (Must): Pay for a held booking**
As a user, I want to pay for my held booking so it becomes confirmed.
- Given my booking is `HELD` and its hold has not expired, when I pay the exact total with a new Idempotency-Key and the simulated outcome succeeds, then the payment is `SUCCEEDED`, the booking `CONFIRMED`, its seats `BOOKED`, and a `booking-confirmed` event is emitted.
- Given I retry with the **same** Idempotency-Key and the same body, then I get the original result again and no second payment exists (BR-PAY-01).
- Given the same key with a **different** body, then `422 IDEMPOTENCY_KEY_REUSED` (BR-PAY-02).
- Given the hold expired, then `409 BOOKING_NOT_PAYABLE` and no payment succeeds.
- Given the simulated outcome is a decline, then the payment is `FAILED` and the booking stays `HELD` until it is paid or expires.
- Given no Idempotency-Key header, then `422`.

### Operations

**US-OPS-01 (Must): Cancel a flight**
As an admin, I want to cancel a flight and have every booking on it cancelled.
- Given `VN123` is `OPEN` with 3 active bookings, when I cancel it, then the flight is `CANCELLED`, all 3 bookings become `CANCELLED`, and one `booking-cancelled` event per booking is emitted with reason `FLIGHT_CANCELLED`. The 24-hour cancellation window does not apply (BR-FLT-07).
- Given `VN123` is `DEPARTED`, then `409 INVALID_FLIGHT_STATUS`.

**US-OPS-02 (Should): Close sales and depart automatically**
As the system, I want flights to stop selling 1 hour before departure and to be marked departed at departure time.
- Given `VN123` is `OPEN` and departs in 59 minutes, when the job runs, then it becomes `CLOSED`.
- Given `VN123` is `CLOSED` and its departure time has passed, when the job runs, then it becomes `DEPARTED`.

### Admin

**US-ADM-01 (Should): Flight manifest.** As an admin, I want the list of confirmed passengers on a flight with their seats. A `HELD` booking is not on the manifest.

**US-ADM-02 (Could): Load factor.** As an admin, I want each flight's load factor (booked ÷ total FlightSeats) per fare class.

**US-ADM-03 (Could): Query the audit log.** As an admin, I want to filter audit entries by target and time range. This needs the first indexes on `audit_logs`, deferred until a query exists (see the CreateAuditLogs migration).

## Won't

Deliberately out of scope. Each is a choice, not a gap.

| Won't build | Why not |
|---|---|
| Real payment gateway | The interesting engineering is idempotency and the hold → pay race, and a simulator exercises both. A real gateway adds credentials, webhooks and PCI concerns that teach nothing new here. |
| Connecting flights / multi-leg itineraries | A booking spanning several flights is a cross-aggregate transaction. That is exactly the saga problem of phase F, and it is not worth solving twice. |
| Return trips | Two independent bookings cover the user need. Linking them adds a parent entity with no new rule. |
| Baggage, meals, add-ons | Price-line items with no new consistency rule. Pure CRUD growth. |
| Check-in and boarding passes | A separate airport-operations domain with document checks and timing windows. Leaving it out keeps the scope on selling seats. |
| Loyalty programme | Its own bounded context (points ledger, tiers) unrelated to seat inventory. |
| Deliberate overbooking | Real airlines oversell on purpose. Here, "a seat is sold at most once" (BR-SEAT-01) is the invariant the concurrency work proves. Overbooking would remove it. |
| Partial refunds and fee schedules | Cancellation is all-or-nothing outside the 24-hour window. Fee tables are pricing policy, not architecture. |
| Multiple currencies | One currency (VND) per system. `Money` still carries a currency code, so adding more later is a data change, not a model change. |
| Internationalisation | Error `code`s are stable and machine-readable. Translating `message` is a client concern. |
| Frontend | This is a backend portfolio project. Postman and the docs are the interface. |
| Saved passenger profiles / travel documents | Passengers are names on a booking. Reusable profiles belong to the Passenger service planned for phase F. |

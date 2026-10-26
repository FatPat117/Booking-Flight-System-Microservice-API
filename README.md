# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Roadmap

Done so far: **A** foundations → messaging (Day 1–30), **B** Identity + Postgres (Day 31–42). Ahead:

| Phase | Focus |
|---|---|
| **D** | Complete booking domain inside `api` — airports, aircraft, schedules, seat maps and holds, multi-passenger bookings, payment, cancellations |
| **E** | CQRS + Mediator + Vertical Slice + DI container |
| **F** | Split into Passenger / Flight / Booking services — REST + events, Saga, Inbox |
| **G** | Observability — OpenTelemetry, Jaeger, Prometheus, Grafana |
| **H** | Production-ready + portfolio — validation lib, OpenAPI, testcontainers, CI, rate limiting, deploy |

Details, principles and why the order is what it is: [docs/roadmap.md](docs/roadmap.md) · [ADR-007](docs/adr/007-domain-before-advanced-patterns.md).

## Architecture

```text
/ (npm workspaces root)
  packages/contracts/         ← @booking-flight-system/contracts (shared event types)
  api/                        ← @booking-flight-system/api (flights + bookings HTTP, outbox relay)
  services/identity/          ← register / login, issues JWTs (identity_db)
  services/flight-notifier/   ← RabbitMQ consumer (flight-created, booking-held, booking-expired, booking-created)

docker-compose.yml
  ├── app              (build context: ., Dockerfile: api/Dockerfile)
  ├── flight-notifier  (build context: ., Dockerfile: services/flight-notifier/Dockerfile)
  ├── rabbitmq
  └── postgres         (identity_db + booking_db, one dedicated role each)

identity runs with `npm run dev` (no compose service yet).
api's outbox table in booking_db bridges api ↔ RabbitMQ (eventual delivery).
```

Object creation happens only in the Composition Root. Routes and use cases receive dependencies; they do not `new` infrastructure themselves.

## Configuration

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | HTTP listening port (`1–65535`) |
| `POSTGRES_HOST` | No | `localhost` | Postgres host (`postgres` inside compose) |
| `POSTGRES_PORT` | No | `5432` | Postgres port |
| `BOOKING_POSTGRES_USER` | Yes | none | api's own role on `booking_db` (not identity's `POSTGRES_USER`) |
| `BOOKING_POSTGRES_PASSWORD` | Yes | none | Password for that role |
| `JWT_SECRET` | Yes | none | Shared with Identity to verify Bearer JWTs (≥32 chars) |
| `RABBITMQ_URL` | No | `amqp://guest:guest@localhost:5672` | AMQP URL (`rabbitmq` host inside compose) |
| `PAYMENT_SIMULATOR_DELAY_MS` | No | `0` | How long the simulated gateway takes per charge and per refund (`0–60000`); only for watching a payment race by hand |

`JWT_SECRET` is required at startup. The application fails fast if it is missing, blank, or shorter than 32 characters.

`RABBITMQ_URL` defaults for local `npm run dev` against compose-mapped port `5672`. Compose sets `amqp://guest:guest@rabbitmq:5672` for the `app` service.

Precedence:

```text
Operating-system environment
  → .env (if loaded)
    → Application defaults (PORT, POSTGRES_HOST, POSTGRES_PORT, RABBITMQ_URL)
```

Local setup:

```bash
cp .env.example .env
# set JWT_SECRET (openssl rand -base64 32)
npm install          # root — installs all workspaces, builds contracts
npm run dev --workspace=@booking-flight-system/api
```

Do not commit `.env`. Only commit `.env.example` with placeholder values.

## Authentication

Identity (`services/identity`, port `3001`) issues JWTs: `POST /api/identity/register`, then `POST /api/identity/login`. `api` verifies them with the shared `JWT_SECRET`.

| Endpoint | Credential |
|---|---|
| `GET /live`, `GET /health`, `GET /ready` | none |
| `GET /api/flights`, `GET /api/flights/:id` | none |
| `GET /api/airports` | none |
| `GET /api/whoami` | any valid JWT |
| `POST /api/flights`, `POST /api/flights/:id/open` | JWT with `role=admin` |
| `POST /api/airports`, `POST /api/aircraft` | JWT with `role=admin` |
| `POST /api/flights/:flightId/bookings` | JWT with `role=user` (an admin gets `403`); the booking's owner is the token's `sub` |
| `GET /api/bookings` | any valid JWT — a user sees their own bookings, an admin sees all |
| `GET /api/bookings/:id`, `GET /api/bookings/by-reference/:reference` | any valid JWT — owner or admin |
| `DELETE /api/bookings/:id` | JWT with `role=user`, owner only |
| `POST /api/bookings/:id/payments` | JWT with `role=user`, owner only (an admin gets `403`) |

Promote an account to admin once with `npm run promote-to-admin -- <email>` in the identity workspace, then log in again to get a token carrying the new role.

**Object-level authorization (Day 44).** Checking the role is not enough: a booking id must also belong to the caller. Ownership is enforced inside the repository queries through a `BookingAccessScope` (`owner` or `admin`), on every query of a flow, including the follow-up read that only picks an error. Another account's booking therefore answers exactly like one that does not exist: `404 BOOKING_NOT_FOUND`, never `403` or `409`, so its existence is not revealed (BR-AUTH-02 in [docs/product/domain-model.md](docs/product/domain-model.md)). A malformed id is also `404`.

Booking request:

```http
POST /api/flights/:flightId/bookings
Content-Type: application/json

{ "passengers": [ { "name": "Nguyen Van A", "seat": "12A" }, { "name": "Tran Thi B", "seat": "12B" } ] }
```

Responses: `201` created with `Location: /api/bookings/:id` (a `HELD` booking, see [Multi-passenger holds](#multi-passenger-holds-and-booking-references-day-48a)), `409 NOT_ENOUGH_SEATS`, `409 SEATS_UNAVAILABLE`, `409 SALES_CLOSED` (the flight is not `OPEN`: not opened yet, cancelled, or within 1 hour of departure — Day 46), `404` flight not found, `422` validation error. `DELETE /api/bookings/:id` returns `204`, then `409` on the owner's second cancel, `404` for an unknown id or another account's booking. `GET /api/bookings` uses the same `page`/`pageSize` rules as flights, newest first.

Missing/invalid/expired JWT on protected routes returns `401 Unauthorized` with `WWW-Authenticate: Bearer`. A valid JWT with the wrong role returns `403 Forbidden`.

## Reference data: airports and aircraft (Day 45)

```http
POST /api/airports
{ "code": "dad", "name": "Da Nang International", "city": "Da Nang", "timeZone": "Asia/Ho_Chi_Minh" }

POST /api/aircraft
{ "registration": "VN-A321", "model": "Airbus A321",
  "seatLayout": { "cabins": [
    { "fareClass": "BUSINESS", "fromRow": 1, "toRow": 2, "seatLetters": "ACDF" },
    { "fareClass": "ECONOMY",  "fromRow": 3, "toRow": 7, "seatLetters": "ABCDEF" } ] } }
```

- Airport codes and registrations are upper-cased before saving, so `dad` and `DAD` collide (`409 AIRPORT_ALREADY_EXISTS` / `409 AIRCRAFT_ALREADY_EXISTS`).
- `timeZone` is an IANA name, never an offset (`+07:00` → `422`). It is validated on write only and stored as given.
- The layout is sent compactly and expanded into one `seats` row per position (primary key `aircraft_id, row, letter`). Overlapping cabins → `422` naming the duplicated seat (e.g. `12A`). Size limits (rows 1–99, ≤ 10 letters from `A`–`K`, ≤ 10 cabins, ≤ 900 seats) are checked **before** expansion. The aircraft and its seats are written atomically.
- `POST /api/aircraft` answers seat counts per fare class, not the expanded seats. Neither write sets `Location`: there is no GET-by-id route yet.
- `GET /api/airports` is public, ordered by code, with the same pagination as flights.
- Flights reference them since Day 46 (next section). No events are published for reference data, since nothing consumes them.
- Dev seed: `npm run seed:reference --workspace=@booking-flight-system/api` adds 25 airports (12 Vietnamese, 13 international including DST zones such as `Europe/London` and `Australia/Sydney`) and 8 aircraft (single- and two-class layouts, one with no row 13). It skips anything that already exists and writes no audit rows.

Rules: BR-REF-01..06 in [docs/product/domain-model.md](docs/product/domain-model.md).

## Flights: references and lifecycle (Day 46)

```http
POST /api/flights
{ "flightNumber": "VN461", "origin": "SGN", "destination": "HAN", "aircraftRegistration": "VN-A323",
  "departureAt": "2026-11-20T08:00:00+07:00", "arrivalAt": "2026-11-20T10:00:00+07:00",
  "fares": { "ECONOMY": 1500000, "BUSINESS": 4200000 } }

POST /api/flights/:id/open
```

- **Breaking change to the create body.** `origin`/`destination` must be registered airports and `aircraftRegistration` a registered aircraft; every unknown one is reported at once (`422 UNKNOWN_AIRPORT` / `UNKNOWN_AIRCRAFT`). `availableSeats` is no longer accepted (`422 UNSUPPORTED_FIELD`): it starts at the aircraft's seat count.
- **One aircraft, one flight at a time** (BR-FLT-03/08): an aircraft is busy from departure until arrival + 45 minutes, a half-open window, so the next flight may leave exactly 45 minutes after landing. A clash answers `409 AIRCRAFT_UNAVAILABLE`. The database decides, through the exclusion constraint `EXCL_flights_aircraft_schedule` (GiST on `aircraft_id` and the occupancy range, ignoring `CANCELLED` flights), so two admins racing for the same aircraft cannot both win.
- **Lifecycle.** A new flight is `SCHEDULED` and cannot be booked. `POST /api/flights/:id/open` (admin) moves it to `OPEN` while departure is more than 1 hour away: `200` with the flight, `409 INVALID_FLIGHT_STATUS` with `details[0].code` = `NOT_ALLOWED` or `DEPARTURE_TOO_SOON`, `409 FLIGHT_STATUS_CHANGED` if a concurrent change won (compare-and-set on the stored status), `404` for an unknown or malformed id. Audited as `FLIGHT_OPENED`; no event.
- **Only `SCHEDULED`, `OPEN` and `CANCELLED` are stored.** `CLOSED` (from 1 hour before departure) and `DEPARTED` are derived from the clock on every read and every seat hold ([ADR-008](docs/adr/008-time-derived-flight-status.md)), so they are right at any moment without a job. `GET /api/flights(/:id)` returns this effective `status`.
- **Booking** holds a seat only while the effective status is `OPEN`; the condition is part of the seat-hold `UPDATE` itself, so a flight cannot close between a check and the write → otherwise `409 SALES_CLOSED`.
- Responses keep `origin`/`destination` as IATA codes (read through a join, not stored) and add `originAirportId`, `destinationAirportId`, `aircraftId`, `status`.
- No route cancels a flight yet: `→ CANCELLED` comes with the booking cascade (phase D step 9).

Rules: BR-FLT-01..08 in [docs/product/domain-model.md](docs/product/domain-model.md).

## Seat inventory and seat map (Day 47)

```http
GET /api/flights/:id/seats
→ 200 { "flightId": "…", "rows": [ { "row": 1, "seats": [ { "code": "1A", "fareClass": "BUSINESS", "status": "HELD" }, … ] }, … ] }
```

- **Each flight owns its seats.** Creating a flight copies its aircraft's layout into `flight_seats` (one row per position, `AVAILABLE`) in the same transaction, so a later layout change cannot touch seats already sold (BR-SEAT-03). Existing flights were migrated expand → backfill → contract, refusing to finish if a flight's bookings did not fit its seats.
- **`availableSeats` is derived, not stored.** `GET /api/flights(/:id)` counts the flight's `AVAILABLE` seats in the same query as the page (a scalar subquery served by the partial index `idx_flight_seats_available`, so a sold-out flight shows `0` instead of disappearing). The `flights.available_seats` column is gone.
- **Booking holds concrete seats** (since Day 48A one per passenger, next section). Cancelling releases them in the same statement that cancels the booking.
- **Concurrency.** A system-picked hold is one statement: `SELECT … FOR UPDATE OF seat SKIP LOCKED FOR SHARE OF flight` then `UPDATE … SET status = 'HELD'`. Concurrent bookings take different seats instead of queueing on the same one; the flight row is share-locked so its sales window cannot change mid-claim ([ADR-004 addendum](docs/adr/004-optimistic-concurrency-control.md)). A check ties `booking_id IS NOT NULL` to a non-`AVAILABLE` status.
- **The seat map is public** (like the flight) and carries no booking id, owner or passenger — only code, fare class and status (`AVAILABLE`, `HELD`, `BOOKED`). Unknown or malformed id → `404 FLIGHT_NOT_FOUND`.

Rules: BR-SEAT-01/03 and Decisions 3 and 10 in [docs/product/domain-model.md](docs/product/domain-model.md).

## Multi-passenger holds and booking references (Day 48A)

```http
POST /api/flights/:flightId/bookings
{ "passengers": [ { "name": "Bob Tran" }, { "name": "Lan Tran" }, { "name": "Minh Tran" } ] }
→ 201 { "id": "…", "reference": "K7Q4PZ", "status": "HELD", "holdExpiresAt": "…+15 min",
        "passengers": [ { "name": "Bob Tran", "seat": "1A" }, … ], … }

GET /api/bookings/by-reference/K7Q4PZ
```

- **Breaking change to the booking body.** `{ "passengerName": … }` is replaced by `passengers`: 1 to 9 (BR-BOOK-01, counted before any passenger is read), each with a non-empty `name`. Either every passenger names a `seat` (`12A`) or none does (BR-BOOK-09); with none the system holds the lowest free seats in (row, letter) order. The old body answers `422 UNSUPPORTED_FIELD`.
- **All or nothing** (BR-SEAT-02): either every passenger gets a seat or no seat is held. `409 NOT_ENOUGH_SEATS` (system-picked), `409 SEATS_UNAVAILABLE` with the taken seat codes in `details` (chosen; never who holds them), `422 UNKNOWN_SEAT` for a code the flight does not have, `422 MIXED_SEAT_SELECTION`, `422 DUPLICATE_SEAT`, `422 INVALID_PASSENGER_COUNT`. `FLIGHT_SOLD_OUT` is gone.
- **A new booking is `HELD` for 15 minutes** (`holdExpiresAt`, BR-BOOK-04) and its seats show `HELD` on the map. Existing bookings were migrated `active → CONFIRMED`, `cancelled → CANCELLED`. A `HELD` booking can be cancelled until its hold expires (Day 48B, below); its passengers keep the seat codes they had, as history.
- **Booking reference** (BR-BOOK-05): 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0/O`, `1/I`), unique (`UQ_bookings_reference`). A clash is drawn again, up to 5 times, inside the same transaction (`INSERT … ON CONFLICT DO NOTHING` keeps it usable). `GET /api/bookings/by-reference/:reference` follows the same ownership rule as by id: another account's or a malformed reference → `404 BOOKING_NOT_FOUND`.
- **Concurrency.** Each hold is a single statement. System-picked seats use `SKIP LOCKED` and a count check in the `UPDATE`'s own `WHERE`, so finding fewer seats than passengers writes nothing. Chosen seats are locked **in (row, letter) order, whatever order the request lists them in**, so `[12A, 12B]` and `[12B, 12A]` cannot deadlock (race tests in `postgres-booking-hold-race.integration.test.ts`).
- **Event `booking-held`** replaces `booking-created` for new bookings (`reference`, `holdExpiresAt`, passengers with seats). flight-notifier consumes it and still consumes `booking-created` for messages sent before Day 48A.

Rules: BR-BOOK-01/02/04/05/09, BR-SEAT-02 and Decision 11 in [docs/product/domain-model.md](docs/product/domain-model.md).

## Hold expiry (Day 48B)

A `HELD` booking expires at `holdExpiresAt` (15 minutes after the hold, BR-BOOK-04). Three places care, each in its own way (Decision 12):

- **Reads derive it.** From the deadline on, `GET /api/bookings/:id`, `/by-reference/:reference` and `GET /api/bookings` show the booking as `EXPIRED`, even if the row still says `HELD`.
- **Decisions check it themselves.** `DELETE /api/bookings/:id` on a lapsed hold answers `409 BOOKING_EXPIRED` and writes nothing — before or after the job swept it. Another account still gets `404`. The boundary is exact (BR-BOOK-10): at instant `t` a hold is expired when `holdExpiresAt <= t`; cancel and payment (Day 49B) need `holdExpiresAt > t`.
- **A job frees the seats.** `booking-hold-expiry-job` runs every 60 s: batches of 50 lapsed holds, at most 20 batches per run, each batch one transaction that marks them `EXPIRED`, releases their seats, writes a `BOOKING_EXPIRED` audit entry (actor `system` / `booking-hold-expiry`) and a `booking-expired` event per booking. Batches are taken with `FOR UPDATE SKIP LOCKED`, so several instances can sweep at once without waiting on or double-expiring each other. A run that hits its batch limit logs `booking_hold_expiry_backlog`.

```http
DELETE /api/bookings/:id        (hold lapsed)
→ 409 { "error": { "code": "BOOKING_EXPIRED", "message": "Booking hold has expired" } }
```

- **Cancel vs expiry at the same moment**: each is one conditional `UPDATE` on the booking row, on complementary sides of the boundary; the row lock lets one through and the other matches nothing. Exactly one end, one audit entry, one event, seats released once (race tests in `postgres-booking-expiry-race.integration.test.ts`).
- **Seat lock order**: cancel and expiry lock a booking's seats in `(row, letter)` order before releasing them — the order a chosen-seat hold locks them in — so a release and a hold on the same seats cannot deadlock (race test E forces the interleaving; the reversed order deadlocks every round).
- **Shutdown** waits for a job run in progress: `JobScheduler.stop()` resolves once the run's transaction is done, then the publisher and the database close.

Rules: BR-BOOK-04/10, Decision 12 in [docs/product/domain-model.md](docs/product/domain-model.md).

## Fares and the price snapshot (Day 49A)

```http
POST /api/flights
{ …, "aircraftRegistration": "VN-A321", "fares": { "ECONOMY": 1500000, "BUSINESS": 4200000 } }
→ 201 { …, "fares": { "ECONOMY": { "amount": 1500000, "currency": "VND" },
                      "BUSINESS": { "amount": 4200000, "currency": "VND" } } }

POST /api/flights/:flightId/bookings
{ "passengers": [ { "name": "Bob Tran", "seat": "1A" }, { "name": "An Le", "seat": "3A" } ] }
→ 201 { …, "passengers": [
          { "name": "Bob Tran", "seat": "1A", "fareClass": "BUSINESS", "price": { "amount": 4200000, "currency": "VND" } },
          { "name": "An Le", "seat": "3A", "fareClass": "ECONOMY", "price": { "amount": 1500000, "currency": "VND" } } ],
        "total": { "amount": 5700000, "currency": "VND" } }
```

- **One fare per fare class, in whole VND.** Amounts are đồng, never ×100 (VND has no subunit in use; BR-MONEY-01). The request carries plain numbers; responses carry `Money` (`{ amount, currency }`). Stored in `flight_fares (flight_id, fare_class)` as `bigint`, capped at 2^53 − 1 by a `CHECK` so every amount is exact as a JS number; the adapter converts the string `pg` returns and throws on anything else.
- **Breaking change to the create body.** `fares` is required; `priceInCents` and `currency` answer `422 UNSUPPORTED_FIELD`. A fare must exist for every class the aircraft has seats in and for no other (BR-FLT-09): `422 MISSING_FARE` / `422 FARE_CLASS_NOT_ON_AIRCRAFT`, reported with unknown airports/aircraft. Also `422 INVALID_FARES`, `INVALID_FARE_CLASS`, `INVALID_FARE`.
- **Reads.** `GET /api/flights(/:id)` return `fares` (one query per page for every fare); the seat map carries `fares` once at the top, not on every seat.
- **The price is copied when the seats are held** (BR-BOOK-03, Decision 13). Each passenger stores the fare class and fare of their seat; the booking's `total` is the sum, derived on every read, never stored. A later fare change does not reach existing bookings.
- **Concurrency.** The hold statement reads the flight's fares `FOR SHARE`: a fare change (an `UPDATE flight_fares`) waits for holds in progress, and a hold arriving during an uncommitted change waits for it, then takes the new fares. Without the lock a booking could commit after a fare change with the old fare (race tests B1/B2 in `postgres-fare-snapshot.integration.test.ts`, with controls).
- **No endpoint changes a fare yet.** To try the snapshot: `docker compose exec -T postgres psql -U booking -d booking_db -c "UPDATE flight_fares SET amount_vnd = 2000000 WHERE flight_id = '<id>' AND fare_class = 'ECONOMY'"`, then read an older booking (unchanged) and book again (new fare).
- **Existing data** was migrated expand → backfill → contract: a `VND` flight's `price_in_cents` became its ECONOMY fare unchanged (it already held đồng); BUSINESS fares and `USD` flights could not be derived, so the contract migration refused with the list until they were set by hand. Passengers of earlier bookings were priced at migration time.
- **Events.** `flight-created` gains `fares`; `priceInCents` (the ECONOMY fare, else the lowest) and `currency: "VND"` are still sent and deprecated. `booking-held` gains each passenger's `fareClass`/`price` and the `total`. Both additions are optional in the parsers.

Rules: BR-MONEY-01, BR-FLT-09, BR-BOOK-03 and Decision 13 in [docs/product/domain-model.md](docs/product/domain-model.md).

## Payment with an Idempotency-Key (Day 49B)

```http
POST /api/bookings/:id/payments
Idempotency-Key: 6f1c2a7e-pay-1
{ "paymentMethodToken": "tok_success", "amount": { "amount": 3000000, "currency": "VND" } }
→ 201 { "payment": { "id": "…", "bookingId": "…", "status": "SUCCEEDED",
                     "amount": { "amount": 3000000, "currency": "VND" },
                     "providerReference": "sim_ch_…", "createdAt": "…" },
        "booking": { …, "status": "CONFIRMED" } }

(same key, same body again) → the identical 201, plus  Idempotent-Replayed: true
```

- **Simulated gateway.** `tok_success` is charged; `tok_decline` and any other token are declined (`card_declined` / `unknown_payment_method`). It runs in the process: no network, no timeout. `PAYMENT_SIMULATOR_DELAY_MS` slows every charge and refund, to watch a race by hand.
- **Three phases, the gateway outside any transaction** ([ADR-009](docs/adr/009-external-calls-outside-transactions.md), Decision 14). Phase 1 (short transaction) claims the key, checks the booking and records a `PROCESSING` payment. Phase 2 calls the gateway with nothing locked. Phase 3 (short transaction) records the outcome and confirms the booking: `HELD → CONFIRMED`, seats `HELD → BOOKED`, `booking-confirmed` through the outbox. Measured (race test E, a 1 s charge): with the charge inside one transaction a cancel waits ~0.9 s and the expiry job skips the locked booking; with three phases the cancel takes 2–11 ms.
- **The race with expiry and cancel.** Confirmation is decided at phase 3 with BR-BOOK-10's `holdExpiresAt > now`. If the booking expired or was cancelled while the gateway charged, the payment becomes `REFUND_PENDING`, that commits, the gateway refunds, and the payment becomes `REFUNDED` (audit actor `system` / `payment-refund`). The answer is `409 BOOKING_NOT_PAYABLE`. To make that rare, a payment only **starts** while the hold has more than 60 s left (BR-PAY-07).
- **Idempotency-Key.** Required, 1–255 visible ASCII characters, scoped to the account. The final answer (`201`, `402`, `409 BOOKING_NOT_PAYABLE`, `404`) is stored with the key in the same transaction as the outcome, as `json` so a replay is byte for byte the first response. The same key with a different body (fingerprint: SHA-256 of method, path and validated body, keys sorted) is `422 IDEMPOTENCY_KEY_REUSED`; while the first request is still running, `409 IDEMPOTENCY_KEY_IN_PROGRESS`. Validation errors, `PAYMENT_AMOUNT_MISMATCH` and `PAYMENT_IN_PROGRESS` are not stored: the key stays usable.
- **Two keys, one booking** (two tabs): at most one `PROCESSING` and one `SUCCEEDED` payment per booking (partial unique indexes); the second gets `409 PAYMENT_IN_PROGRESS`.

| Answer | When |
|---|---|
| `201` | Charged and confirmed |
| `402 PAYMENT_DECLINED` | Declined; the booking stays `HELD`, pay again with a new key |
| `409 BOOKING_NOT_PAYABLE` | Not `HELD`, hold lapsed, 60 s or less left, or lost to expiry/cancel during the charge (then refunded) |
| `409 IDEMPOTENCY_KEY_IN_PROGRESS` / `409 PAYMENT_IN_PROGRESS` | The same key / another key is paying this booking right now |
| `422 IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_REUSED` / `PAYMENT_AMOUNT_MISMATCH` / `VALIDATION_FAILED` | Key missing / reused with another body / amount ≠ total / malformed key or body |
| `404 BOOKING_NOT_FOUND` / `403` | Another account's booking / an admin |

No `Location` and no `GET` for a payment: no story reads one. Rules: BR-PAY-01..07 and Decision 14 in [docs/product/domain-model.md](docs/product/domain-model.md).

## Audit trail

Every successful write records an audit entry in the `audit_logs` table, in the same Postgres transaction as the write itself. If the audit insert fails, the whole write rolls back.

| Action | Trigger | Actor recorded today |
|---|---|---|
| `FLIGHT_CREATED` | `POST /api/flights` | `account` / admin's JWT `sub` (metadata includes `aircraftRegistration`, `fares` as `ECONOMY:1500000,BUSINESS:4200000`) |
| `FLIGHT_OPENED` | `POST /api/flights/:id/open` | `account` / admin's JWT `sub` (metadata: `previousStatus`) |
| `BOOKING_CREATED` | `POST /api/flights/:flightId/bookings` | `account` / owner's JWT `sub` (metadata: `reference`, `passengerCount`, `seats`, `totalVnd`, `holdExpiresAt` — no passenger names) |
| `BOOKING_CANCELLED` | `DELETE /api/bookings/:id` | `account` / owner's JWT `sub` |
| `BOOKING_EXPIRED` | `booking-hold-expiry-job` | `system` / `booking-hold-expiry` (metadata: `reference`, `seats`, `holdExpiresAt`) |
| `BOOKING_CONFIRMED` | `POST /api/bookings/:id/payments` (charged and confirmed) | `account` / payer's JWT `sub` (metadata: `reference`, `paymentId`, `amountVnd`) |
| `PAYMENT_FAILED` | same, gateway declined | `account` / payer's JWT `sub`; target `payment` (metadata: `bookingId`, `reason`) |
| `PAYMENT_REFUND_PENDING` | same, charged but the booking expired or was cancelled | `account` / payer's JWT `sub`; target `payment` |
| `PAYMENT_REFUNDED` | the refund after it | `system` / `payment-refund`; target `payment` |
| `AIRPORT_REGISTERED` | `POST /api/airports` | `account` / admin's JWT `sub` |
| `AIRCRAFT_REGISTERED` | `POST /api/aircraft` | `account` / admin's JWT `sub` (metadata: seats per fare class) |

Stored fields: audit id, action, actor type and id, target type and id, request id, occurred timestamp, metadata (jsonb).

Rows written before Day 44 keep their original `admin_api_key/admin` and `passenger/anonymous` actors — the log is append-only.

## Composition Root (manual DI)

`createApplication()` is the single place that constructs and wires the object graph:

```text
Config + Logger
  → Postgres DataSource (private; migrations run on boot)
  → Flight/Booking repositories, AuditRecorder, OutboxRepository, TransactionRunner, HealthChecks
  → CreateFlight / ListFlights / CreateBooking / CancelBooking / ExpireHolds
  → MessagePublisher (RabbitMQ, private)
  → JobScheduler + flights-summary-job + outbox-relay-job + booking-hold-expiry-job (private; started on boot)
  → Application { ... , close() }
```

The Postgres `DataSource` and job scheduler are not part of the public `Application` type. Consumers use repositories / health checks; shutdown goes through `close()` (stop jobs → close publisher → destroy DataSource).

`index.ts` only parses config, builds the runtime, hands dependencies to Express, and manages process shutdown via `runtime.close()`.

This is constructor-style Dependency Injection without a DI framework. Frameworks such as NestJS / Inversify automate the same wiring later — they do not replace the idea.

## Background jobs

The process runs an in-memory `JobScheduler` alongside HTTP.

Current jobs:

| Job | Interval | Behavior |
|-----|----------|----------|
| `flights-summary-job` | 60s (default) | Logs `flights_summary` with total flight count via `Logger` |
| `outbox-relay-job` | 5s (default) | Publishes unpublished outbox rows (see Messaging) |
| `booking-hold-expiry-job` | 60s (default) | Expires lapsed holds in batches of 50, at most 20 per run (see Hold expiry) |

Design notes:

- Jobs are independent of any HTTP request.
- Failures are logged; they do not crash the process or other jobs.
- Recursive `setTimeout` avoids overlapping runs of the same job.
- `stop()` waits for the run in progress before it resolves (Day 48B), so `close()` never destroys the `DataSource` under a running transaction.
- Multi-instance deployments would duplicate job execution (accepted while a single instance runs — no distributed lock).
- Flight count reuses `FlightRepository.findPage({ limit: 1 }).totalItems` (`COUNT(*)` in the database), avoiding a new repository method for one consumer.

## Docker

The API ships as a multi-stage image: TypeScript builds in a `build` stage; the `runtime` stage keeps only compiled JS + production dependencies, runs as non-root `appuser`, and probes `GET /live`.

Requires **Node 22+** (`engines` + `FROM node:22-slim`). Day 18 needed it for the built-in `node:sqlite`, removed on Day 41; the floor stays because Node 20 reached end-of-life (2026-04-30) and 22 is the oldest maintained LTS, matching the Docker base image.

```bash
docker build -f api/Dockerfile -t booking-api .

# Git Bash on Windows: prefix with MSYS_NO_PATHCONV=1 so /app/... is not rewritten.
docker run --rm -p 3000:3000 \
  -e JWT_SECRET="replace-with-at-least-32-character-secret!!" \
  -e POSTGRES_HOST=host.docker.internal \
  -e BOOKING_POSTGRES_USER=booking -e BOOKING_POSTGRES_PASSWORD=booking_dev_password \
  booking-api
```

| Concern | How it is handled |
|---------|------------------------|
| Reproducible runtime | Pinned `node:22-slim`, `npm ci`, lockfile |
| Secrets | `.env` is in `.dockerignore` — pass `-e` / compose `env_file` at run time |
| Persistence | None in the image — data lives in Postgres |
| Graceful stop | `CMD ["node", "api/dist/index.js"]` as PID 1; `SIGTERM` → `runtime.close()` |
| Health | Docker `HEALTHCHECK` uses `/live` (process up), not `/ready` (DB ready) |

Docker packages the **runtime environment**. It does not fix multi-instance job duplication — scaling replicas still runs `flights-summary-job` once per process.

## docker-compose

`docker-compose.yml` runs `app`, `flight-notifier`, RabbitMQ and Postgres for local development. Compose reads `.env` next to the compose file (do not commit `.env`).

```bash
# Ensure .env has JWT_SECRET (≥32 chars). Compose loads it automatically.
docker compose up --build

curl http://localhost:3000/live
# RabbitMQ Management UI: http://localhost:15672  (guest / guest — local only)

docker compose down
```

> **Before `docker compose down -v`:** stop every `npm run dev` that is still running (`ps aux | grep tsx`). `-v` wipes the shared Postgres/RabbitMQ volumes out from under those processes, and their restart-on-change makes the resulting errors look like real bugs (Day 40).

| Concern | How it is handled |
|---------|-------------------|
| Topology | One YAML: `app`, `flight-notifier`, `rabbitmq`, `postgres` |
| Startup order | `app` waits until `rabbitmq` and `postgres` are **healthy** (`depends_on` + healthcheck) |
| DNS inside the compose network | Service names (`rabbitmq`, `postgres`) resolve from `app`, not `localhost` |
| Persistence | Named volumes `rabbitmq_data` and `identity_postgres_data` (Postgres holds both `identity_db` and `booking_db`) |
| Restart | `app` and `flight-notifier` use `restart: unless-stopped` |

From the host use `localhost:15672`. From inside the `app` container, connection uses hostname `rabbitmq` via `RABBITMQ_URL`.

Verify internal DNS:

```bash
docker compose exec app sh -c "getent hosts rabbitmq"
```

## Messaging

Every successful write enqueues an outbox row in the same Postgres transaction as the write and its audit entry: `flight-created`, `booking-held` (`booking-created` before Day 48A), `booking-cancelled`, `booking-expired` (written by the expiry job, Day 48B), `booking-confirmed` (a paid booking, Day 49B). `outbox-relay-job` (default every 5s) reads unpublished rows and publishes each to the durable queue named after its event type.

| Decision | Choice | Why |
|----------|--------|-----|
| Payload | Fat event (`eventId`, `correlationId`, `type`, `occurredAt`, full entity) | Consumers need no callback into `api` |
| Publish path | Outbox relay (not direct from the use case) | Write + event intent are atomic in one Postgres transaction; RabbitMQ can be down |
| Delivery | Eventual (relay interval, default 5s) | Trade latency for reliability — no lost events when broker is unavailable |
| Publish failure in relay | Log `outbox_publish_failed`; retry next tick | Row stays unpublished until publish succeeds |
| Order | Relay stops batch on first failure (`break`) | Preserve publish order by `created_at` |
| DLQ | `<queue>.dlq` via a per-queue dead-letter exchange | Poison messages after delivery — manual investigation only |

Startup connects publisher with bounded retry (`connectPublisherWithRetry`, 10 × 2s) then fail-fast. `close()` is async: stop jobs → close publisher → close DB.

After startup, the publisher reconnects lazily: an unexpected connection/channel close (e.g. RabbitMQ restart) drops the session and logs `rabbitmq_connection_lost`; the next `publish()` opens a new connection (`rabbitmq_reconnected`). There is no separate retry timer — a failed reconnect fails that publish, the outbox row stays unpublished, and the relay retries on its next tick. `flight-notifier` recovers differently: it crashes and `restart: unless-stopped` + `connectConsumerWithRetry` bring it back.

### flight-notifier service

`services/flight-notifier/` has its own `package.json`, build, Dockerfile and process. It subscribes to `flight-created`, `booking-held`, `booking-expired` and `booking-created` (no longer produced since Day 48A; kept for messages already queued), validates each event against `packages/contracts`, logs `flight_created_consumed` (with `fares` since Day 49A) / `booking_held_consumed` (reference, passenger count and `total`, no names) / `booking_expired_consumed` (reference and seat count) / `booking_created_consumed` with the `correlationId` (for `booking-expired`, the event's own id: no request is behind it), and acks/nacks manually. `booking-cancelled` is published but has no consumer yet.

`flight-created` evolves additively (Day 46): the payload gained `originAirportId`, `destinationAirportId`, `aircraftId` and `status`, while `origin`/`destination` (IATA codes) and `availableSeats` stay. The new fields are optional in the parser, because old-shape messages may still sit in the outbox, queue or DLQ, and rejected only when present but empty. The producer maps the payload field by field, so a field added to `Flight` is never published by accident. Making them required, or dropping the old fields, is a later contract step. Day 49A added `fares` the same way and marked `priceInCents`/`currency` deprecated (still sent: the ECONOMY fare in whole VND, and `"VND"`).

| Concern | Choice |
|---------|--------|
| Code sharing | `packages/contracts` via npm workspaces ([ADR-003](docs/adr/003-npm-workspaces-shared-contracts.md)) |
| Communication | RabbitMQ only — no HTTP/import between services |
| Health | `restart: unless-stopped`; no fake HTTP healthcheck |
| api role | Publish only; no in-process consumer |

```bash
docker compose up --build
# POST /api/flights → app publishes → flight-notifier logs consume
```

## Database migrations

The application runs TypeORM migrations (`api/src/postgres/migrations/`) on startup, right after the `DataSource` initializes. Applied migrations are tracked in TypeORM's `migrations` table.

| Migration | Purpose |
|---|---|
| `CreateFlights` | `flights` (TIMESTAMPTZ dates, chronological CHECK, unique flight number + departure) |
| `CreateOutbox` | `outbox` (jsonb payload, partial index on unpublished rows) |
| `CreateAuditLogs` | `audit_logs` |
| `CreateBookings` | `bookings` (FK to `flights`, status CHECK) |
| `AddBookingOwner` / `RequireBookingOwner` | `bookings.owner_account_id` (expand, then contract to `NOT NULL`) |
| `CreateAirportsAndAircraft` | `airports` (unique code), `aircraft` (unique registration), `seats` (PK `aircraft_id, row, letter`) |
| `ExpandFlightReferences` / `BackfillFlightReferences` / `ContractFlightReferences` | `flights.origin_airport_id`, `destination_airport_id`, `aircraft_id`, `status`: add nullable, backfill airports from the old codes (status `OPEN`), then refuse with a list of the flights still missing a reference, or make them `NOT NULL` with FKs and CHECKs and drop the text columns |
| `AddAircraftScheduleExclusion` | `btree_gist`, the `IMMUTABLE` `flight_aircraft_occupancy()` range and `EXCL_flights_aircraft_schedule` |
| `MoveBookingsToLifecycle` | booking status `active`/`cancelled` → `CONFIRMED`/`CANCELLED`, CHECK `HELD`/`CONFIRMED`/`CANCELLED`/`EXPIRED`, `hold_expires_at` required while `HELD` |
| `AddBookingReference` | `bookings.reference`: backfilled from `gen_random_uuid()` bytes, then `NOT NULL`, `UQ_bookings_reference` and a format CHECK |
| `CreateBookingPassengers` / `ContractBookingPassengers` | `booking_passengers` (1–9 positions, a seat once per booking), backfilled one per booking; the contract refuses with a list if a `CONFIRMED` booking's seats and passengers disagree, else drops `bookings.passenger_name` |
| `AllowHeldSeats` | seat status `HELD`; `UQ_flight_seats_booking_id` replaced by the partial index `idx_flight_seats_booking_id` (a booking now holds several seats) |
| `AddBookingHoldExpiryIndex` | partial index `idx_bookings_held_expiry` on `(hold_expires_at, id) WHERE status = 'HELD'`: the expiry sweep reads its batch in order and stops at `LIMIT` (no sort of every due hold) |
| `CreateFlightFares` / `BackfillFlightFares` / `ContractFlightFares` | `flight_fares` (PK `flight_id, fare_class`, `amount_vnd bigint` between 1 and 2^53 − 1); a `VND` flight's `price_in_cents` becomes its ECONOMY fare unchanged; the contract refuses with a list while a class with seats has no fare (BUSINESS, `USD` flights) or a fare has no seats, else drops `price_in_cents` and `currency` |
| `AddPassengerFareSnapshot` | `booking_passengers.fare_class`, `price_vnd`, priced from the seat's class at migration time; refuses with a list if a seated passenger cannot be priced; CHECK seat, class and price are NULL together |

Since Day 46 each migration runs in its own transaction (`migrationsTransactionMode: "each"`): a refused contract migration keeps the expand and backfill, so the missing data can be fixed by hand and the migrations re-run. The aircraft of an existing flight cannot be guessed, so it is assigned by hand, e.g. `UPDATE flights SET aircraft_id = (SELECT id FROM aircraft WHERE registration = 'VN-A321') WHERE flight_number = 'VN123';`. A fare cannot be guessed either (no exchange rate belongs in a migration): `INSERT INTO flight_fares (flight_id, fare_class, amount_vnd) VALUES ('<id>', 'BUSINESS', 4200000);`.

Run them without starting the app: `npm run postgres:migration:run --workspace=@booking-flight-system/api`.

## Health endpoints

### GET /live

Liveness check. Returns 200 when the HTTP process is alive.

```json
{
  "status": "ok"
}
```

### GET /health

Backward-compatible alias for `/live`.

### GET /ready

Readiness check. Verifies that the application can query Postgres (`SELECT 1`).

Healthy response:

```json
{
  "status": "ok",
  "checks": {
    "database": {
      "status": "ok"
    }
  }
}
```

If a critical dependency is unavailable, returns `503 Service Unavailable`.

## Application flow

```text
Request
  → observability middleware (requestId + logs)
  → express.json / routes
  → JWT verify + role check (flight and reference-data writes, every booking route)
  → CreateFlight | OpenFlight | ListFlights | GetFlight | CreateBooking | CancelBooking | GetBooking | GetBookingByReference | ListBookings
    (booking reads derive EXPIRED for a lapsed hold)
    | RegisterAirport | ListAirports | RegisterAircraft
  → TransactionRunner (every write)
      ├── Flight / Booking / Airport / Aircraft repositories → Postgres
      ├── AuditRecorder → Postgres audit_logs
      └── OutboxRepository → Postgres outbox (booking-held | booking-cancelled | flight-created)

JobScheduler → booking-hold-expiry-job → ExpireHolds
  → TransactionRunner (one per batch): expire due holds + release seats, audit, outbox (booking-expired)
```

Every response includes header `x-request-id` (generated or echoed from the client).

### List flights pagination

| Param | Default | Rules |
|-------|---------|-------|
| `page` | `1` | Positive safe integer |
| `pageSize` | `20` | Integer `1–100` |

Response shape:

```json
{
  "items": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

Invalid pagination → `422`. Empty page beyond the end → `200` with empty `items`.

## Scripts

Run from **repo root** (workspace commands):

```bash
npm install
npm run typecheck
npm run typecheck:test
npm run build
npm test                                                          # unit + HTTP tier, no infrastructure
npm run test:integration --workspace=@booking-flight-system/api   # needs Postgres; TRUNCATEs booking_db tables
npm run seed:reference --workspace=@booking-flight-system/api     # dev airports + aircraft; safe to re-run
npm run dev --workspace=@booking-flight-system/api
npm start --workspace=@booking-flight-system/api
```

## Postman

Import `postman/Booking-microservices.postman_collection.json` and `postman/Booking-microservices.local.postman_environment.json`. See `postman/README.md`.

## Current limitations

- `owner_account_id` has no foreign key to Identity's accounts (different database by design) — deleting an account does not touch its bookings
- No route cancels a flight yet (phase D step 9); a status change other than the creation has no event
- `Flight` is both the write model and the read shape; only `status` is mapped to a separate `FlightView`
- Two overlapping flights of one aircraft inserted at the same instant can deadlock (`40P01`) instead of failing the exclusion constraint; the loser is answered `409 AIRCRAFT_UNAVAILABLE`, which is safe to retry if the winner also rolled back
- Payment failures are not reconciled yet (phase D step 6c, Day 49C): a gateway error of unknown outcome leaves the payment `PROCESSING` and its key in progress (a retry with that key gets `409 IDEMPOTENCY_KEY_IN_PROGRESS`, another key `409 PAYMENT_IN_PROGRESS`, until the hold expires); a refund the gateway refuses leaves `REFUND_PENDING` with a `payment_refund_failed` warning; Idempotency-Keys are never deleted (24 h cleanup is 49C)
- The refund runs inside the paying request, after the commit: a slow refund delays that request's `409` (with `PAYMENT_SIMULATOR_DELAY_MS=8000` the answer took 16 s)
- After a hold lapses, its seats stay `HELD` on the seat map until the expiry job's next run — up to ~60 s plus the run itself. The seat cannot be sold twice in that gap and the booking already reads `EXPIRED`; accepted (Decision 12)
- A failing expiry batch rolls back whole and is retried on the next run: one booking that keeps failing holds back the others of its batch (head-of-line, like the outbox relay). The hold duration (15 min) is a constant, not configuration
- No endpoint changes a fare (only psql); one that is added must keep BR-FLT-09 and go through `UPDATE flight_fares`, so the hold's share lock still orders it against holds. Passengers of bookings made before Day 49A carry the fare at migration time, not the one at their hold (it was never recorded)
- `flight-created` still sends the deprecated `priceInCents`/`currency`; dropping them is a later contract step once no consumer reads them
- A seat cannot be changed after booking (phase D step 7)
- Two system-picked multi-seat holds racing for the last seats could in theory both find fewer seats than needed (each skips rows the other just locked) and both answer `409 NOT_ENOUGH_SEATS`; not observed in 200 measured rounds (Day 48A race test A)
- The flight list counts seats for every row the `OFFSET` skips, so deep pages get slower (measured Day 47: 1.4 ms on page 1, 52 ms on page 100 of 2000 flights); flights have no index on `(departure_at, id)`
- Seat layouts cannot be edited (BR-REF-05); there are no read routes for a single airport or aircraft
- Roles are a single `user` | `admin` claim — no permission tables, no refresh tokens
- A role change takes effect only at the next login: a token keeps the role it was issued with until it expires, both after promotion (still `403`) and after demotion (still admin)
- Manual DI only (no DI container)
- In-process jobs only — duplicate execution if multiple instances run (the hold expiry job is safe with several thanks to `SKIP LOCKED`; the outbox relay is not); job intervals hardcoded in the Composition Root; no job timeout
- Outbox relay polls every 5s; duplicate delivery possible if `markPublished` fails after a successful publish
- `eventId` is on every event, but consumers have no dedupe store yet
- `booking-cancelled` is published but has no consumer and no shared contract type, so its queue only grows. Next step: add `BookingCancelledEvent` to `packages/contracts`, validate it in a `bookingCancelledConsumer` in `flight-notifier` (same shape as `bookingCreatedConsumer`, with its own DLQ), then drain the queue
- Dead-letter queues are inspected manually — no auto-retry or alerting; no outbox monitoring
- `/ready` checks Postgres only (`SELECT 1`), not RabbitMQ
- Transactions are local to `booking_db`; no nested transactions (they throw `NestedTransactionError`); no cross-service transactions
- Migrations run in-process at startup (safe only while one instance runs); no down migrations, no zero-downtime strategy
- `guest`/`guest` RabbitMQ credentials are for local compose only
- Logs go to console only; no metrics or distributed tracing
- Offset pagination only (no cursor)

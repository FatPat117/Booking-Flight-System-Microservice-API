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
  services/flight-notifier/   ← RabbitMQ consumer (flight-created, booking-created)

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
| `GET /api/bookings/:id` | any valid JWT — owner or admin |
| `DELETE /api/bookings/:id` | JWT with `role=user`, owner only |

Promote an account to admin once with `npm run promote-to-admin -- <email>` in the identity workspace, then log in again to get a token carrying the new role.

**Object-level authorization (Day 44).** Checking the role is not enough: a booking id must also belong to the caller. Ownership is enforced inside the repository queries through a `BookingAccessScope` (`owner` or `admin`), on every query of a flow, including the follow-up read that only picks an error. Another account's booking therefore answers exactly like one that does not exist: `404 BOOKING_NOT_FOUND`, never `403` or `409`, so its existence is not revealed (BR-AUTH-02 in [docs/product/domain-model.md](docs/product/domain-model.md)). A malformed id is also `404`.

Booking request:

```http
POST /api/flights/:flightId/bookings
Content-Type: application/json

{ "passengerName": "Nguyen Van A" }
```

Responses: `201` created with `Location: /api/bookings/:id`, `409 FLIGHT_SOLD_OUT`, `409 SALES_CLOSED` (the flight is not `OPEN`: not opened yet, cancelled, or within 1 hour of departure — Day 46), `404` flight not found, `422` validation error. `DELETE /api/bookings/:id` returns `204`, then `409` on the owner's second cancel, `404` for an unknown id or another account's booking. `GET /api/bookings` uses the same `page`/`pageSize` rules as flights, newest first.

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
  "priceInCents": 1500000, "currency": "VND" }

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

## Audit trail

Every successful write records an audit entry in the `audit_logs` table, in the same Postgres transaction as the write itself. If the audit insert fails, the whole write rolls back.

| Action | Trigger | Actor recorded today |
|---|---|---|
| `FLIGHT_CREATED` | `POST /api/flights` | `account` / admin's JWT `sub` (metadata includes `aircraftRegistration`) |
| `FLIGHT_OPENED` | `POST /api/flights/:id/open` | `account` / admin's JWT `sub` (metadata: `previousStatus`) |
| `BOOKING_CREATED` | `POST /api/flights/:flightId/bookings` | `account` / owner's JWT `sub` |
| `BOOKING_CANCELLED` | `DELETE /api/bookings/:id` | `account` / owner's JWT `sub` |
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
  → CreateFlight / ListFlights / CreateBooking / CancelBooking
  → MessagePublisher (RabbitMQ, private)
  → JobScheduler + flights-summary-job + outbox-relay-job (private; started on boot)
  → Application { ... , close() }
```

The Postgres `DataSource` and job scheduler are not part of the public `Application` type. Consumers use repositories / health checks; shutdown goes through `close()` (stop jobs → close publisher → destroy DataSource).

`index.ts` only parses config, builds the runtime, hands dependencies to Express, and manages process shutdown via `runtime.close()`.

This is constructor-style Dependency Injection without a DI framework. Frameworks such as NestJS / Inversify automate the same wiring later — they do not replace the idea.

## Background jobs

The process runs an in-memory `JobScheduler` alongside HTTP.

Current job:

| Job | Interval | Behavior |
|-----|----------|----------|
| `flights-summary-job` | 60s (default) | Logs `flights_summary` with total flight count via `Logger` |

Design notes:

- Jobs are independent of any HTTP request.
- Failures are logged; they do not crash the process or other jobs.
- Recursive `setTimeout` avoids overlapping runs of the same job.
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

Every successful write enqueues an outbox row in the same Postgres transaction as the write and its audit entry: `flight-created`, `booking-created`, `booking-cancelled`. `outbox-relay-job` (default every 5s) reads unpublished rows and publishes each to the durable queue named after its event type.

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

`services/flight-notifier/` has its own `package.json`, build, Dockerfile and process. It subscribes to `flight-created` and `booking-created`, validates each event against `packages/contracts`, logs `flight_created_consumed` / `booking_created_consumed` with the `correlationId`, and acks/nacks manually. `booking-cancelled` is published but has no consumer yet.

`flight-created` evolves additively (Day 46): the payload gained `originAirportId`, `destinationAirportId`, `aircraftId` and `status`, while `origin`/`destination` (IATA codes) and `availableSeats` stay. The new fields are optional in the parser, because old-shape messages may still sit in the outbox, queue or DLQ, and rejected only when present but empty. The producer maps the payload field by field, so a field added to `Flight` is never published by accident. Making them required, or dropping the old fields, is a later contract step.

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

Since Day 46 each migration runs in its own transaction (`migrationsTransactionMode: "each"`): a refused contract migration keeps the expand and backfill, so the missing data can be fixed by hand and the migrations re-run. The aircraft of an existing flight cannot be guessed, so it is assigned by hand, e.g. `UPDATE flights SET aircraft_id = (SELECT id FROM aircraft WHERE registration = 'VN-A321') WHERE flight_number = 'VN123';`.

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
  → CreateFlight | OpenFlight | ListFlights | GetFlight | CreateBooking | CancelBooking | GetBooking | ListBookings
    | RegisterAirport | ListAirports | RegisterAircraft
  → TransactionRunner (every write)
      ├── Flight / Booking / Airport / Aircraft repositories → Postgres
      ├── AuditRecorder → Postgres audit_logs
      └── OutboxRepository → Postgres outbox (booking-created | flight-created)
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
- `availableSeats` is still a stored counter, initialized from the aircraft's seats; per-seat inventory comes with phase D step 4
- Seat layouts cannot be edited (BR-REF-05); there are no read routes for a single airport or aircraft
- Roles are a single `user` | `admin` claim — no permission tables, no refresh tokens
- A role change takes effect only at the next login: a token keeps the role it was issued with until it expires, both after promotion (still `403`) and after demotion (still admin)
- Manual DI only (no DI container)
- In-process jobs only — duplicate execution if multiple instances run; job intervals hardcoded in the Composition Root; no job timeout
- Outbox relay polls every 5s; duplicate delivery possible if `markPublished` fails after a successful publish
- `eventId` is on every event, but consumers have no dedupe store yet
- `booking-cancelled` has no consumer and no shared contract type
- Dead-letter queues are inspected manually — no auto-retry or alerting; no outbox monitoring
- `/ready` checks Postgres only (`SELECT 1`), not RabbitMQ
- Transactions are local to `booking_db`; no nested transactions (they throw `NestedTransactionError`); no cross-service transactions
- Migrations run in-process at startup (safe only while one instance runs); no down migrations, no zero-downtime strategy
- `guest`/`guest` RabbitMQ credentials are for local compose only
- Logs go to console only; no metrics or distributed tracing
- Offset pagination only (no cursor)

# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 27)

```text
/ (npm workspaces root)
  packages/contracts/     ← @booking-flight-system/contracts (FlightCreatedEvent)
  api/                    ← @booking-flight-system/api (HTTP + outbox relay)
  services/flight-notifier/ ← consumer

docker-compose.yml
  ├── app          (build context: ., Dockerfile: api/Dockerfile)
  ├── flight-notifier (build context: ., Dockerfile: services/flight-notifier/Dockerfile)
  └── rabbitmq
        └── outbox in Postgres (booking_db) bridges app ↔ broker (eventual delivery)
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
| `JWT_SECRET` | Yes | none | Shared with Identity; Bearer JWT for `POST /api/flights` (≥32 chars) |
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

Public endpoints (no credential):

```text
GET /live
GET /health
GET /ready
GET /api/flights
GET /api/flights/:id
POST /api/flights/:flightId/bookings
```

Protected write endpoint (Day 34 — JWT + role):

```http
POST /api/flights
Authorization: Bearer <accessToken with role=admin>
```

Register via Identity, promote once with `npm run promote-to-admin -- <email>` in the identity workspace, then login to obtain the token.

Booking endpoint (public — no credential):

```http
POST /api/flights/:flightId/bookings
Content-Type: application/json

{ "passengerName": "Nguyen Van A" }
```

Responses: `201` created, `409` sold out, `404` flight not found, `422` validation error.

Missing/invalid/expired JWT on protected routes returns `401 Unauthorized` with `WWW-Authenticate: Bearer`. Valid JWT with wrong role returns `403 Forbidden`.

## Audit trail

Successful flight creation records an audit entry in the `audit_logs` table (Postgres).

Current audited action:

| Action | Trigger |
|---|---|
| `FLIGHT_CREATED` | Successful `POST /api/flights` |
| `BOOKING_CREATED` | Successful `POST /api/flights/:flightId/bookings` |

Stored audit fields include:

- audit id
- action
- actor type and id
- target type and id
- request id
- occurred timestamp
- metadata JSON

Current actor model:

```text
actorType = admin_api_key
actorId   = admin
```

Because the system currently uses one shared admin API key, audit logs do not identify an individual human user.

Flight creation and its `FLIGHT_CREATED` audit record are written inside a single Postgres transaction.

If audit recording fails after the flight insert, the transaction is rolled back and the flight is not persisted.

## Composition Root (Manual DI)

`createApplication()` is the single place that constructs and wires the object graph:

```text
Config + Logger
  → Database (private to Composition Root)
  → Repository / AuditRecorder / TransactionRunner / HealthChecks
  → CreateFlight / ListFlights
  → JobScheduler + flights-summary-job (private; started on boot)
  → Application { ... , close() }
```

The Postgres `DataSource` and job scheduler are not part of the public `Application` type. Consumers use repositories / health checks; shutdown goes through `close()` (stop jobs, then close database).

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
- Multi-instance deployments would duplicate job execution (accepted for Day 17 — no broker / distributed lock yet).
- Flight count reuses `FlightRepository.findPage({ limit: 1 }).totalItems` (`COUNT(*)` in the database), avoiding a new repository method for one consumer.

## Docker (Day 18)

The API ships as a multi-stage image: TypeScript builds in a `build` stage; the `runtime` stage keeps only compiled JS + production dependencies, runs as non-root `appuser`, and probes `GET /live`.

Requires **Node 22+** (`engines` + `FROM node:22-slim`). Day 18 needed it for the built-in `node:sqlite`, removed on Day 41; the floor stays because Node 20 reached end-of-life (2026-04-30) and 22 is the oldest maintained LTS, matching the Docker base image.

```bash
docker build -t booking-api:day18 .

# Git Bash on Windows: prefix with MSYS_NO_PATHCONV=1 so /app/... is not rewritten.
docker run --rm -p 3000:3000 \
  -e JWT_SECRET="replace-with-at-least-32-character-secret!!" \
  -e POSTGRES_HOST=host.docker.internal \
  -e BOOKING_POSTGRES_USER=booking -e BOOKING_POSTGRES_PASSWORD=booking_dev_password \
  booking-api:day18
```

| Concern | How Day 18 handles it |
|---------|------------------------|
| Reproducible runtime | Pinned `node:22-slim`, `npm ci`, lockfile |
| Secrets | `.env` is in `.dockerignore` — pass `-e` / compose `env_file` at run time |
| Persistence | None in the image — data lives in Postgres (Day 40+; the Day 18 `/app/data` SQLite volume was removed on Day 41) |
| Graceful stop | `CMD ["node", "dist/index.js"]` as PID 1; `SIGTERM` → `runtime.close()` |
| Health | Docker `HEALTHCHECK` uses `/live` (process up), not `/ready` (DB ready) |

Docker packages the **runtime environment**. It does not fix Day 17 multi-instance job duplication — scaling replicas still runs `flights-summary-job` once per process.

## docker-compose (Day 19)

`docker-compose.yml` runs the API and RabbitMQ together for local multi-container development. Compose reads `.env` next to the compose file for `${JWT_SECRET}` (do not commit `.env`).

```bash
# Ensure .env has JWT_SECRET (≥32 chars). Compose loads it automatically.
docker compose up --build

curl http://localhost:3000/live
# RabbitMQ Management UI: http://localhost:15672  (guest / guest — local only)

docker compose down
```

> **Before `docker compose down -v`:** stop every `npm run dev` that is still running (`ps aux | grep tsx`). `-v` wipes the shared Postgres/RabbitMQ volumes out from under those processes, and their restart-on-change makes the resulting errors look like real bugs (Day 40).

| Concern | How Day 19 handles it |
|---------|------------------------|
| Multi-container topology | One YAML: `app` + `rabbitmq` |
| Startup order | `app` waits until `rabbitmq` is **healthy** (`depends_on` + healthcheck) |
| DNS inside the compose network | Service name `rabbitmq` resolves from `app` (not `localhost`) |
| Persistence | Named volumes `rabbitmq_data` and `identity_postgres_data` (Postgres holds both `identity_db` and `booking_db`) |
| App ↔ broker code | **Publisher only** — `CreateFlight` publishes `flight-created` after DB commit; no consumer yet |

From the host use `localhost:15672`. From inside the `app` container, connection uses hostname `rabbitmq` via `RABBITMQ_URL`.

Verify internal DNS:

```bash
docker compose exec app sh -c "getent hosts rabbitmq"
```

## Messaging (Day 20–24)

After a successful `POST /api/flights` (outcome `created`), the app enqueues a row in the Postgres `outbox` table inside the same transaction as flight + audit. `outbox-relay-job` (default every 5s) reads unpublished rows and publishes to durable queue `flight-created`.

| Decision | Choice | Why |
|----------|--------|-----|
| Payload | Fat event (`type`, `occurredAt`, full `flight`) | No consumer API callback yet; UI can inspect the body |
| Publish path | Outbox relay (not direct from `CreateFlight`) | Flight + event intent are atomic in one Postgres transaction; RabbitMQ can be down |
| Delivery | Eventual (relay interval, default 5s) | Trade latency for reliability — no lost events when broker is unavailable |
| Publish failure in relay | Log `outbox_publish_failed`; retry next tick | Row stays unpublished until publish succeeds |
| Order | Relay stops batch on first failure (`break`) | Preserve publish order by `created_at` |
| DLQ | `flight-created.dlq` via dead-letter exchange | Poison messages after delivery — manual investigation only |

Startup connects publisher with bounded retry (`connectPublisherWithRetry`, 10 × 2s) then fail-fast. `close()` is async: stop jobs → close publisher → close DB.

After startup, the publisher reconnects lazily (Day 41): an unexpected connection/channel close (e.g. RabbitMQ restart) drops the session and logs `rabbitmq_connection_lost`; the next `publish()` opens a new connection (`rabbitmq_reconnected`). There is no separate retry timer — a failed reconnect fails that publish, the outbox row stays unpublished, and the relay retries on its next tick. `flight-notifier` recovers differently: it crashes and `restart: unless-stopped` + `connectConsumerWithRetry` bring it back.

### flight-notifier service (Day 22)

Consumer logic moved to `services/flight-notifier/` — its own `package.json`, build, Dockerfile, and process. It subscribes to `flight-created`, validates the event contract, logs `flight_created_consumed`, and acks/nacks manually.

| Concern | Day 22 choice |
|---------|----------------|
| Code sharing | Controlled copy into `flight-notifier` (no monorepo yet) |
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
  → optional API key auth (POST /api/flights only)
  → CreateFlight | CreateBooking | ListFlights | findById
  → TransactionRunner (create flight / create booking)
      ├── FlightRepository / BookingRepository → Postgres
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
npm test
npm run dev --workspace=@booking-flight-system/api
npm start --workspace=@booking-flight-system/api
```

## Postman

Import `postman/Booking-microservices.postman_collection.json` and `postman/Booking-microservices.local.postman_environment.json`. See `postman/README.md`.

## Current limitations

- Manual DI only (no DI container / NestJS / Inversify / tsyringe)
- In-process jobs only — duplicate execution if multiple instances / containers run
- No job persistence / retry after process crash
- Job interval hardcoded in Composition Root (not env config yet)
- No handler timeout if a job hangs forever
- RabbitMQ publisher in `app`; consumer in separate `flight-notifier` service
- `FlightCreatedEvent` + `BookingCreatedEvent` in `packages/contracts` — `BookingCancelledEvent` not shared yet (no consumer)
- Outbox relay polls every 5s (not immediate publish); duplicate delivery possible if `markPublished` fails after successful publish
- Dead-letter: rejected/poison messages route to `*.dlq` via per-queue DLX — manual inspection only (no auto-retry or alerting)
- `guest`/`guest` RabbitMQ credentials are for local compose only
- Transaction support is local to one Postgres database (`booking_db`)
- No nested transaction or savepoint support yet
- No cross-service or distributed transaction
- No outbox monitoring or DLQ alerting
- `/ready` does not include RabbitMQ — a broker outage shows up only as `outbox_publish_failed` logs and unpublished outbox rows
- `eventId` in flight-created payload (Day 25) — consumer dedupe store not built yet; duplicate delivery still possible
- No migration CLI yet
- No down/rollback migrations
- No schema diff tooling
- No zero-downtime migration strategy
- Migrations run in-process at application startup
- Audit `actor` for flight create still labeled `admin_api_key` (auth is JWT; actor typing not migrated yet)
- Roles are a single `user` | `admin` claim — no permission tables
- Current health checks only verify Postgres with a lightweight `SELECT 1`
- Logs go to console only (no transports / log level config)
- Offset pagination only (no cursor)
- Configuration covers port, database path, JWT secret, and RabbitMQ URL
- Use case / repository still synchronous
- No OAuth, metrics, or distributed tracing

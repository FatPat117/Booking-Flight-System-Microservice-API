# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 21)

```text
docker-compose.yml
  ├── service: app
  │     └── createApplication()
  │           ├── Database → Repositories → CreateFlight / ListFlights
  │           ├── JobScheduler → flights-summary-job
  │           ├── MessagePublisher → publish flight-created (own AMQP connection)
  │           ├── MessageConsumer → subscribe flight-created (own AMQP connection)
  │           │     └── manual ack/nack, prefetch(1), log handler
  │           └── close() → jobs.stop → publisher.close → consumer.close → db.close
  │
  └── service: rabbitmq
        └── queue: flight-created (Ready drops to 0 after consume)
```

Object creation happens only in the Composition Root. Routes and use cases receive dependencies; they do not `new` infrastructure themselves.

## Configuration

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | HTTP listening port (`1–65535`) |
| `DATABASE_PATH` | No | `data/booking.db` | SQLite database file (relative or absolute) |
| `ADMIN_API_KEY` | Yes | none | Bearer token required for `POST /api/flights` |
| `RABBITMQ_URL` | No | `amqp://guest:guest@localhost:5672` | AMQP URL (`rabbitmq` host inside compose) |

`ADMIN_API_KEY` is required at startup. The application fails fast if it is missing, blank, or shorter than 16 characters.

`RABBITMQ_URL` defaults for local `npm run dev` against compose-mapped port `5672`. Compose sets `amqp://guest:guest@rabbitmq:5672` for the `app` service.

Precedence:

```text
Operating-system environment
  → .env (if loaded)
  → Application defaults (PORT, DATABASE_PATH, RABBITMQ_URL)
```

Local setup:

```bash
cp .env.example .env
# set ADMIN_API_KEY to a local secret (at least 16 characters)
npm run dev
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
```

Protected write endpoint:

```http
POST /api/flights
Authorization: Bearer <ADMIN_API_KEY>
```

Missing or invalid credentials return `401 Unauthorized` with `WWW-Authenticate: Bearer`.

This is minimal API key authentication — not JWT, OAuth, or role-based access control.

## Audit trail

Successful flight creation records an audit entry in the local SQLite database.

Current audited action:

| Action | Trigger |
|---|---|
| `FLIGHT_CREATED` | Successful `POST /api/flights` |

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

Flight creation and its `FLIGHT_CREATED` audit record are written inside a single SQLite transaction.

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

The SQLite connection and job scheduler are not part of the public `Application` type. Consumers use repositories / health checks; shutdown goes through `close()` (stop jobs, then close database).

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
- Flight count reuses `FlightRepository.findPage({ limit: 1 }).totalItems` (SQLite `COUNT(*)`), avoiding a new repository method for one consumer.

## Docker (Day 18)

The API ships as a multi-stage image: TypeScript builds in a `build` stage; the `runtime` stage keeps only compiled JS + production dependencies, runs as non-root `appuser`, and probes `GET /live`.

Requires **Node 22+** (`engines` + `FROM node:22-slim`) because the app uses built-in `node:sqlite`.

```bash
docker build -t booking-api:day18 .

# Git Bash on Windows: prefix with MSYS_NO_PATHCONV=1 so /app/... is not rewritten.
docker run --rm -p 3000:3000 \
  -e ADMIN_API_KEY="local-dev-secret-1234567890" \
  -e DATABASE_PATH=/app/data/booking.db \
  -v booking_data:/app/data \
  booking-api:day18
```

| Concern | How Day 18 handles it |
|---------|------------------------|
| Reproducible runtime | Pinned `node:22-slim`, `npm ci`, lockfile |
| Secrets | `.env` is in `.dockerignore` — pass `-e` / compose `env_file` at run time |
| SQLite persistence | Named volume on `/app/data` matching `DATABASE_PATH` |
| Graceful stop | `CMD ["node", "dist/index.js"]` as PID 1; `SIGTERM` → `runtime.close()` |
| Health | Docker `HEALTHCHECK` uses `/live` (process up), not `/ready` (DB ready) |

Docker packages the **runtime environment**. It does not fix Day 17 multi-instance job duplication — scaling replicas still runs `flights-summary-job` once per process.

## docker-compose (Day 19)

`docker-compose.yml` runs the API and RabbitMQ together for local multi-container development. Compose reads `.env` next to the compose file for `${ADMIN_API_KEY}` (do not commit `.env`).

```bash
# Ensure .env has ADMIN_API_KEY (16+ chars). Compose loads it automatically.
docker compose up --build

curl http://localhost:3000/live
# RabbitMQ Management UI: http://localhost:15672  (guest / guest — local only)

docker compose down
```

| Concern | How Day 19 handles it |
|---------|------------------------|
| Multi-container topology | One YAML: `app` + `rabbitmq` |
| Startup order | `app` waits until `rabbitmq` is **healthy** (`depends_on` + healthcheck) |
| DNS inside the compose network | Service name `rabbitmq` resolves from `app` (not `localhost`) |
| Persistence | Named volumes `booking_data` and `rabbitmq_data` |
| App ↔ broker code | **Publisher only** — `CreateFlight` publishes `flight-created` after DB commit; no consumer yet |

From the host use `localhost:15672`. From inside the `app` container, connection uses hostname `rabbitmq` via `RABBITMQ_URL`.

Verify internal DNS:

```bash
docker compose exec app sh -c "getent hosts rabbitmq"
```

## Messaging (Day 20)

After a successful `POST /api/flights` (outcome `created`), the app publishes to durable queue `flight-created`.

| Decision | Choice | Why |
|----------|--------|-----|
| Payload | Fat event (`type`, `occurredAt`, full `flight`) | No consumer API callback yet; UI can inspect the body |
| Publish failure | Log `flight_created_publish_failed`; still return `201` | DB is source of truth; message is a side notification |
| Order | After SQLite transaction commits | Avoid announcing a flight that rolled back |
| Dual-write | Accepted limitation | Outbox pattern is a later day |

Startup connects with bounded retry (`connectPublisherWithRetry` / `connectConsumerWithRetry`, 10 × 2s) then fail-fast. Publisher and consumer use **separate** AMQP connections. `close()` is async: stop jobs → close publisher → close consumer → close DB.

### Consumer (Day 21)

The same process also **subscribes** to `flight-created` and logs each valid event (`flight_created_consumed`). This closes the publish → queue → consume → ack loop for learning; splitting into a second microservice comes later.

| Concern | Day 21 choice |
|---------|----------------|
| Ack mode | Manual (`noAck: false`) |
| Prefetch | `1` — one in-flight message at a time |
| Invalid / rejected | `nack(..., requeue: false)` — drop poison messages (no DLQ yet) |
| Handler | Discriminated `processed` / `rejected` — no throw for bad payloads |
| Delivery | At-least-once — log-only handler is intentionally idempotent-friendly |

## Database migrations

The application runs SQLite migrations on startup.

Applied migrations are tracked in the `schema_migrations` table.

Current migrations:

| ID | Purpose |
|---|---|
| `001_create_flights` | Creates the `flights` table |
| `002_create_audit_logs` | Creates the `audit_logs` table and indexes |

Migration behavior:

- Pending migrations run in order.
- Each migration is recorded after successful execution.
- Failed migrations roll back and fail startup.
- Existing Day 14 databases are adopted through `CREATE TABLE IF NOT EXISTS`.

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

Readiness check. Verifies that the application can query its SQLite database.

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
  → CreateFlight | ListFlights | findById
  → TransactionRunner (create only)
      ├── FlightRepository → SQLite flights
      └── AuditRecorder → SQLite audit_logs
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

```bash
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm start
```

## Postman

Import `postman/Booking-microservices.postman_collection.json` and `postman/Booking-microservices.local.postman_environment.json`. See `postman/README.md`.

## Current limitations

- Manual DI only (no DI container / NestJS / Inversify / tsyringe)
- In-process jobs only — duplicate execution if multiple instances / containers run
- No job persistence / retry after process crash
- Job interval hardcoded in Composition Root (not env config yet)
- No handler timeout if a job hangs forever
- RabbitMQ publisher + in-process consumer — not yet a separate microservice
- Dual-write: SQLite commit + AMQP publish are not atomic (no outbox yet)
- No dead-letter queue; rejected/poison messages are dropped (`requeue: false`)
- No retry for transient consume failures
- Consumer handler is log-only (no side-effect idempotency challenge yet)
- `guest`/`guest` RabbitMQ credentials are for local compose only
- Transaction support is local to one SQLite database connection
- No nested transaction or savepoint support yet
- No cross-service or distributed transaction
- No outbox pattern yet
- No migration CLI yet
- No down/rollback migrations
- No schema diff tooling
- No zero-downtime migration strategy
- Migrations run in-process at application startup
- API key is a single shared secret (no per-user identity, rotation, or expiry)
- Current health checks only verify SQLite with a lightweight `SELECT 1`
- Logs go to console only (no transports / log level config)
- Offset pagination only (no cursor)
- Configuration only covers port, database path, admin API key, and RabbitMQ URL
- Use case / repository still synchronous
- No JWT, OAuth, RBAC, metrics, distributed tracing, or events

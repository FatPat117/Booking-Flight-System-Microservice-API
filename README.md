# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 16)

```text
Environment / .env
  → parseConfig() → AppConfig
  → createApplication()   ← Composition Root (src/bootstrap/application.ts)
      ├── openDatabase() → runMigrations()
      ├── Console Logger
      ├── HealthChecks
      ├── SQLite FlightRepository
      ├── SQLite AuditRecorder
      ├── SQLite TransactionRunner
      ├── CreateFlight / ListFlights
      └── close() lifecycle
            ↓
          createApp() → Express (receives wired dependencies)
```

Object creation happens only in the Composition Root. Routes and use cases receive dependencies; they do not `new` infrastructure themselves.

## Configuration

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | HTTP listening port (`1–65535`) |
| `DATABASE_PATH` | No | `data/booking.db` | SQLite database file (relative or absolute) |
| `ADMIN_API_KEY` | Yes | none | Bearer token required for `POST /api/flights` |

`ADMIN_API_KEY` is required at startup. The application fails fast if it is missing, blank, or shorter than 16 characters.

Precedence:

```text
Operating-system environment
  → .env (if loaded)
  → Application defaults (PORT, DATABASE_PATH only)
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
  → Database
  → Repository / AuditRecorder / TransactionRunner / HealthChecks
  → CreateFlight / ListFlights
  → Application { ... , close() }
```

`index.ts` only parses config, builds the application, hands dependencies to Express, and manages process shutdown via `application.close()`.

This is constructor-style Dependency Injection without a DI framework. Frameworks such as NestJS / Inversify automate the same wiring later — they do not replace the idea.

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
- No background jobs yet
- No Docker / container packaging yet
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
- Configuration only covers port, database path, and admin API key
- Use case / repository still synchronous
- No JWT, OAuth, RBAC, metrics, distributed tracing, or events

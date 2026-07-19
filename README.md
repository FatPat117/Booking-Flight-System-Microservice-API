# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 11)

```text
Environment / .env
  → parseConfig() → AppConfig
  → Composition root (index.ts)
      ├── Console Logger
      ├── HealthChecks (SQLite SELECT 1)
      ├── SQLite FlightRepository
      ├── CreateFlight
      └── ListFlights
            ↓
          Express
            ├── Request observability
            ├── /live /health /ready
            ├── API routes / use cases
            └── Structured unexpected-error logs
```

## Configuration

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | HTTP listening port (`1–65535`) |
| `DATABASE_PATH` | No | `data/booking.db` | SQLite database file (relative or absolute) |

Precedence:

```text
Operating-system environment
  → .env (if loaded)
  → Application defaults
```

Missing values use defaults. Blank or invalid **provided** values fail startup (fail-fast).

Local setup:

```bash
cp .env.example .env
# edit if needed
npm run dev
```

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
  → CreateFlight | ListFlights | findById
  → FlightRepository → SQLite

Unexpected errors
  → structured logger.error (server-side)
  → generic 500 JSON (client)
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

## Current limitations

- Current health checks only verify SQLite with a lightweight `SELECT 1`. They do not check disk space, migration version, write capability, broker dependencies, or downstream services.
- Logs go to console only (no transports / log level config)
- Offset pagination only (no cursor)
- Page + count queries are not a single snapshot transaction
- Configuration only covers port and SQLite path
- Use case / repository still synchronous
- Manual validation (verbose on purpose)
- Schema via `CREATE TABLE IF NOT EXISTS` — not migrations
- No auth, metrics, distributed tracing, or events

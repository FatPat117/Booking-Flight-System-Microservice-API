# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 10)

```text
Environment / .env
  → parseConfig() → AppConfig
  → Composition root (index.ts)
      ├── Console Logger
      ├── SQLite FlightRepository
      ├── CreateFlight
      └── ListFlights
            ↓
          Express
            ├── Request observability (x-request-id, start/finish logs)
            ├── Routes / use cases
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

- Logs go to console only (no transports / log level config)
- Offset pagination only (no cursor)
- Page + count queries are not a single snapshot transaction
- Configuration only covers port and SQLite path
- Use case / repository still synchronous
- Manual validation (verbose on purpose)
- Schema via `CREATE TABLE IF NOT EXISTS` — not migrations
- No auth, metrics, distributed tracing, or events

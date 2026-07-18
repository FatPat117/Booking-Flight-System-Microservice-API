# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 9)

```text
Environment / .env
  → parseConfig() → AppConfig
  → Composition root (index.ts)
      ├── SQLite FlightRepository
      ├── CreateFlight
      └── ListFlights
            ↓
          Express
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
POST /api/flights
  → CreateFlight → FlightRepository → SQLite

GET /api/flights?page=&pageSize=
  → ListFlights → findPage(limit/offset) → SQLite

GET /api/flights/:id
  → FlightRepository.findById
```

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

- Offset pagination only (no cursor)
- Page + count queries are not a single snapshot transaction
- Configuration only covers port and SQLite path
- Use case / repository still synchronous
- Manual validation (verbose on purpose)
- Schema via `CREATE TABLE IF NOT EXISTS` — not migrations
- No auth, structured logging, events

# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 7)

```text
POST /api/flights
  → CreateFlight Use Case
  → FlightRepository
  → SqliteFlightRepository
  → SQLite

GET /api/flights
  → FlightRepository (no use case — intentional)
```

Composition (`index.ts`):

```text
openDatabase
  → createSqliteFlightRepository
  → createCreateFlight({ repository, generateId })
  → createApp({ flightRepository, createFlight })
  → listen
```

## Create outcomes

| Application outcome | HTTP |
|---------------------|------|
| `created` | `201` + `Location` |
| `validation_failed` | `422 VALIDATION_FAILED` |
| `duplicate` | `409 FLIGHT_ALREADY_EXISTS` |

## Scripts

```bash
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm start
```

## Current limitations

- Read routes call repository directly (no GetFlight use cases yet)
- Use case / repository still synchronous
- Manual validation (verbose on purpose)
- Schema via `CREATE TABLE IF NOT EXISTS` — not migrations
- Port / DB path hardcoded
- No auth, pagination, structured logging, events

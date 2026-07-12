# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 6)

```text
Client
  → Express (HTTP + validation + status decisions)
  → FlightRepository (application contract)
  → SqliteFlightRepository (SQL + row mapping)
  → SQLite file
```

Composition root (`index.ts`):

```text
openDatabase → createSqliteFlightRepository → createApp(repository) → listen
```

## Flight creation rules

Same as Day 5. Uniqueness enforced by SQLite `UNIQUE (flight_number, departure_at)`. Repository translates `changes === 0` → `{ outcome: "duplicate" }`; route maps that to `409`.

## HTTP errors

| Status | Code |
|-------:|------|
| 400 | `MALFORMED_JSON` |
| 404 | `ROUTE_NOT_FOUND` / `FLIGHT_NOT_FOUND` |
| 409 | `FLIGHT_ALREADY_EXISTS` |
| 422 | `VALIDATION_FAILED` |
| 500 | `INTERNAL_SERVER_ERROR` |
| 201 | Created (+ `Location`) |

## Scripts

```bash
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm start
```

## Current limitations

- Validation + orchestration still live in `app.ts` (no Service Layer yet)
- Repository API is synchronous (`DatabaseSync` can block the event loop)
- Schema via `CREATE TABLE IF NOT EXISTS` — not migrations
- Port / DB path hardcoded
- Unsupported method → `ROUTE_NOT_FOUND` (not `405`)
- No auth, structured logging, pagination

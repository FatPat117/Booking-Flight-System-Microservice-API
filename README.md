# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Architecture (Day 5)

```text
Client → Express → Validation → Prepared SQL → SQLite file (source of truth)
```

Production database: `data/booking.db` (gitignored).  
Tests use `:memory:` or temporary files — never the production file.

## Flight creation rules

### Rule 1 — Required fields

`flightNumber`, `origin`, `destination`, `departureAt`, `arrivalAt`, `priceInCents`, `currency`, `availableSeats`

### Rule 2 — String fields

Must be non-empty strings (whitespace-only counts as empty).

### Rule 3 — Airport codes

`origin` / `destination` = exactly 3 letters.

### Rule 4 — Origin ≠ destination

After trim + uppercase.

### Rule 5 — Date-time

ISO-8601 with timezone; calendar components must exist; stored as UTC text.

### Rule 6 — Price

`priceInCents` must be a **safe** integer `> 0` (`Number.isSafeInteger`). No string coercion.

### Rule 7 — Available seats

Safe integer `>= 0` (zero = sold out).

### Rule 8 — Currency

`VND` | `USD` only.

### Rule 9 — Uniqueness

`UNIQUE (flight_number, departure_at)` in SQLite. Insert uses `ON CONFLICT DO NOTHING`; `changes === 0` → `409`.

Application validation and DB constraints both exist on purpose: HTTP-friendly errors vs stored-state integrity.

## HTTP status / error convention

| Status | Code | Meaning |
|-------:|------|---------|
| 400 | `MALFORMED_JSON` | Body failed JSON parse |
| 404 | `ROUTE_NOT_FOUND` | No matching endpoint |
| 404 | `FLIGHT_NOT_FOUND` | Flight missing |
| 409 | `FLIGHT_ALREADY_EXISTS` | Unique constraint conflict |
| 422 | `VALIDATION_FAILED` | Shape / business rule failure |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected |
| 201 | — | Created (+ `Location`) |

Middleware order: `express.json` → routes → `notFoundHandler` → `errorHandler`

## Scripts

```bash
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm start
```

## Current limitations

- SQL lives next to routes in `app.ts` (observed pressure — not Repository yet)
- Schema via `CREATE TABLE IF NOT EXISTS` — not a migration system
- `DatabaseSync` is synchronous and can block the event loop
- SQLite embedded file — not PostgreSQL / multi-writer server
- Port and DB path hardcoded
- Unsupported method → `ROUTE_NOT_FOUND` (not `405`)
- No auth, structured logging, pagination

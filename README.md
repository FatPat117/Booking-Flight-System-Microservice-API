# Booking System Evolution

Learning project: grow a booking backend from a single Express API toward microservices — without copying the final architecture early.

## Flight creation rules

### Rule 1 — Required fields

`flightNumber`, `origin`, `destination`, `departureAt`, `arrivalAt`, `priceInCents`, `currency`, `availableSeats`

### Rule 2 — String fields

Must be non-empty strings (whitespace-only counts as empty):
`flightNumber`, `origin`, `destination`, `departureAt`, `arrivalAt`, `currency`

### Rule 3 — Airport codes

`origin` and `destination` must be exactly 3 letters (e.g. `SGN`, `HAN`). Not a full aviation model.

### Rule 4 — Origin ≠ destination

Compared after trim + uppercase.

### Rule 5 — Date-time

ISO-8601 with explicit timezone (`Z` or `±HH:MM`). `arrivalAt` must be after `departureAt`. Stored as UTC (`toISOString()`).

### Rule 6 — Price

`priceInCents` must be a JSON integer `> 0`. Strings like `"15000000"` are rejected (no coercion).

### Rule 7 — Available seats

`availableSeats` must be an integer `>= 0`. Zero is valid (sold out).

### Rule 8 — Currency

Only `VND` and `USD` (normalized to uppercase).

### Rule 9 — Uniqueness

`flightNumber + departureAt` (canonical UTC) must be unique → otherwise `409 Conflict`.

## HTTP status convention

| Case | Status |
|------|--------|
| Invalid JSON syntax | `400` (Express parser) |
| Shape / business rule failure | `422` + `VALIDATION_FAILED` |
| Duplicate scheduled flight | `409` + `FLIGHT_ALREADY_EXISTS` |
| Created | `201` + `Location` |

## Current limitations

- In-memory store: data lost on restart
- Duplicate check is not concurrency-safe across multiple processes
- Manual validation (no Joi/Zod yet — on purpose)
- No automated tests yet
- Route handler owns many responsibilities (observed pressure, not refactored yet)

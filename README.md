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

ISO-8601 with explicit timezone (`Z` or `±HH:MM`). Calendar components must exist (no Feb 30, no hour 25; leap years handled). `arrivalAt` must be after `departureAt`. Stored as UTC (`toISOString()`).

### Rule 6 — Price

`priceInCents` must be a JSON integer `> 0`. Strings like `"15000000"` are rejected (no coercion).

### Rule 7 — Available seats

`availableSeats` must be an integer `>= 0`. Zero is valid (sold out).

### Rule 8 — Currency

Only `VND` and `USD` (normalized to uppercase).

### Rule 9 — Uniqueness

`flightNumber + departureAt` (canonical UTC) must be unique → otherwise `409 Conflict`.

## HTTP status / error convention

All errors use:

```json
{
  "error": {
    "code": "STABLE_CODE",
    "message": "Human-readable message"
  }
}
```

Validation failures also include `details: ValidationIssue[]`.

| Status | Code | Meaning |
|-------:|------|---------|
| 400 | `MALFORMED_JSON` | Body failed JSON parse |
| 404 | `ROUTE_NOT_FOUND` | No matching endpoint (also unsupported methods for now) |
| 404 | `FLIGHT_NOT_FOUND` | Flight route matched; resource missing |
| 409 | `FLIGHT_ALREADY_EXISTS` | Conflict with current state |
| 422 | `VALIDATION_FAILED` | Shape / business rule failure (`details` may include `INVALID_BODY`, etc.) |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected failure (no internal leak) |
| 201 | — | Created (+ `Location`) |

Parser uses `express.json({ strict: false })` so any `JSON.parse()` value reaches the validator. Shape checks live at the trust boundary. Malformed JSON is mapped in the central error middleware.

Middleware order:

```text
express.json → routes → notFoundHandler → errorHandler
```

## Scripts

```bash
npm run dev
npm run typecheck
npm run typecheck:test
npm run build
npm test
npm start
```

## Current limitations

- In-memory store: data lost on restart
- Duplicate check is not concurrency-safe across multiple processes
- Manual validation (no Joi/Zod yet — on purpose)
- Route handler still owns many Flight responsibilities
- Unsupported HTTP method currently returns `ROUTE_NOT_FOUND`, not `405`
- Logging is only `console.error` for unexpected errors (no structured logger / request IDs)

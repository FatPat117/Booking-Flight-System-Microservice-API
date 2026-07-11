# Day 4 — Session Notes

**Date started:** 2026-07-11
**Theme:** Consistent API errors + centralized error middleware
**Status:** COMPLETED (2026-07-11) — Implementation complete — awaiting review

## Real pressure

```text
Route/validation/duplicate → JSON
Malformed JSON / unknown route / unexpected → default Express (HTML/stack)
```

## Must build

```text
src/http-errors.ts  → sendApiError, notFoundHandler, errorHandler, malformed JSON predicate
src/app.ts          → order: json → routes → notFound → errorHandler
tests               → failing tests first, then implementation
README              → error table + limitations (405, logging)
```

## Error codes

| Status | Code |
|-------:|------|
| 400 | MALFORMED_JSON |
| 404 | ROUTE_NOT_FOUND |
| 404 | FLIGHT_NOT_FOUND |
| 409 | FLIGHT_ALREADY_EXISTS |
| 422 | VALIDATION_FAILED |
| 500 | INTERNAL_SERVER_ERROR |

## NOT today

AppError hierarchy, Problem Details, Winston/Sentry, 405 registry, Controller/Service/Repo

## Workflow

1. Write failing tests (malformed JSON JSON contract, unknown route)
2. Implement http-errors.ts
3. Wire middleware order
4. Refactor routes to sendApiError
5. Unexpected error test on mini Express app (not production route)
6. Quality gate

## After completion

Status: Implementation complete — awaiting review (do not self-mark Ready for Day 5)

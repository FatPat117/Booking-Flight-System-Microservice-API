# Day 7 — Session Notes

**Date started:** 2026-07-12
**Theme:** CreateFlight Use Case — separate business flow from Express
**Status:** COMPLETED (2026-07-12) — Implementation complete — awaiting review

## Real pressure

POST route still owns validate → normalize → UUID → Flight → repo → HTTP status.

## Must build

```text
types: CreateFlightInput (explicit, not Omit)
src/flights/flight-validation.ts
src/flights/create-flight.ts  → outcomes: created | validation_failed | duplicate
createApp({ flightRepository, createFlight })
GET still calls repository directly
tests/create-flight.test.ts (fake repo, no Express/SQLite)
```

## NOT today

FlightService CRUD blob, CQRS, Mediator, DI container, Controller classes, read use cases for GET

## Quality gate

Keep API contract; existing 48 tests + new unit tests.

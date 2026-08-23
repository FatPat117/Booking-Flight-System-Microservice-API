# Day 26 — Session Notes

**Date completed:** 2026-08-23
**Theme:** Booking domain + Optimistic Concurrency Control (seat reservation)
**Status:** Completed (code + tests)

## Delivered

```text
Migration 004_create_bookings (id, flight_id FK, passenger_name, created_at, idx on flight_id)
BookingRepository port: reserveSeat (OCC) + create
SqliteBookingRepository: atomic UPDATE ... WHERE available_seats > 0; disambiguate sold-out vs flight-not-found only when changes === 0
CreateBooking use case: validate → transaction(reserveSeat → create → audit BOOKING_CREATED → outbox booking-created)
POST /api/flights/:flightId/bookings — public, no admin key
  201 created | 409 sold-out | 404 flight-not-found | 422 validation
Race condition test: Promise.all with 1 seat → exactly 1 created + 1 sold-out, availableSeats === 0
```

## Optimistic Concurrency Control (OCC)

```text
Problem: read availableSeats in code, then UPDATE in a second step → two concurrent requests can both read "1 seat left" and both succeed (overbooking).

Fix: one atomic SQL statement decides and writes together:
  UPDATE flights SET available_seats = available_seats - 1 WHERE id = ? AND available_seats > 0

If changes === 1 → reserved. If changes === 0 → either flight missing or sold out (small SELECT COUNT only in that failure path for user-facing reason).

No pessimistic locking (SELECT FOR UPDATE) today — node:sqlite doesn't offer row-level FOR UPDATE like Postgres; for a simple decrement-with-condition, OCC is simpler and portable.
```

## Why reserveSeat and create are separate methods

```text
reserveSeat = domain action on flights (hold a seat, passenger-agnostic)
create = persist who booked (bookings row)
CreateBooking orchestrates both in one transaction — single responsibility per repository method.
```

## sold-out early return — nothing to roll back

```text
When UPDATE matches 0 rows, no seat was decremented — transaction can return sold-out/flight-not-found without undoing side effects. Only successful reserveSeat + create + audit + outbox should commit together.
```

## HTTP 409 vs 400 for sold-out

```text
400 = malformed request. Sold-out request is valid; resource state (no seats) conflicts with the operation → 409 Conflict.
```

## SQLite write serialization — test still matters

```text
node:sqlite serializes writers on one file, so Promise.all may queue at DB layer — race is harder to reproduce than on Postgres.

Test is not worthless: wrong SELECT-then-UPDATE logic can still overbook even under serialization; test verifies business outcomes (1 created, 1 sold-out, seats never negative).
```

## Infrastructure reuse (Day 12–25 → Booking)

```text
Reused unchanged: TransactionRunner, OutboxRepository, AuditRecorder pattern, Composition Root wiring, validation style, eventId in outbox payload.
New domain-only code: bookings table, BookingRepository, CreateBooking, route, audit action BOOKING_CREATED.
Outbox relay publishes booking-created rows same as flight-created (no new relay code).
Payoff: second domain added without changing transaction/outbox/audit abstractions.
```

## Day 24 Bước 6 (carry-over — closed)

```text
Part 1 PASS: RabbitMQ stopped → 201 + outbox published_at NULL
Part 2 PASS: RabbitMQ up → relay ~5s → published_at set + flight_created_consumed (verified 2026-08-23)
```

## Quality gate

```text
npm run typecheck && npm run typecheck:test && npm test
155 tests pass (api)
```

## Remaining limitations

```text
No booking consumer in flight-notifier yet (booking-created queued only)
No pessimistic locking / version column OCC variant
SQLite hides some concurrency edge cases — logic must stay correct for future Postgres migration
Day 24 Part 2 self-heal verified (outbox relay + notifier consume)
```

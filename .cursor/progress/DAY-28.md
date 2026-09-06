# Day 28 — Session Notes

**Date completed:** 2026-09-06
**Theme:** Booking consumer + Cancel Booking (OCC reverse)
**Status:** Completed (code + tests)

## Why BookingCreatedEvent enters contracts today (not Day 26)

```text
Day 26: publisher-only → YAGNI for shared package.
Day 28: flight-notifier consumes booking-created → ≥2 sides need the shape.
eventId included from day one (Day 25 lesson applied immediately).
```

## Consumer #2 cost (vs Day 21)

```text
New code: booking-created-consumer.ts (~30 lines) + 1 subscribe() line in index.ts + unit test.
Reused unchanged: rabbitmq-consumer assertQueue/DLX/ack/nack, connect-with-retry, Logger.
Shared package: import parseBookingCreatedEvent — no duplicate type file.
Marginal cost is low; Day 27 workspace payoff is measurable.
```

## CancelBooking + OCC (double-cancel)

```text
UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'active'
changes === 1 → releaseSeat + audit BOOKING_CANCELLED + outbox booking-cancelled
changes === 0 → SELECT: not-found vs already-cancelled — NO seat release
Same principle as Day 26 reserveSeat (conditional UPDATE), opposite resource pressure.
```

## API design choice: already-cancelled → 409

```text
Chose 409 Conflict (not idempotent 204).
Reason: clients can distinguish first successful cancel from a repeat;
not-found stays 404. Documented in app.ts route comment.
```

## Migration 005

```text
ALTER TABLE bookings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'cancelled'));
DEFAULT backfills Day 26 rows — no NULL / ambiguous state.
booking-cancelled outbox event intentionally NOT in contracts (no consumer yet).
```

## Quality gate

```text
npm run typecheck && npm run typecheck:test && npm test
167 tests pass (163 api + 4 flight-notifier)
```

## Day 27 hangover closed

```text
No duplicate flight-created-event.ts
Contracts imported by api + flight-notifier
Local typecheck/test PASS
E2E smoke: POST /api/flights → flight_created_consumed (verified on new machine)
```

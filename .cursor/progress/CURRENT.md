# CURRENT PROGRESS

**Last completed day:** Day 28
**Current day:** Day 28 — Booking consumer + Cancel Booking
**Status:** Code complete — 167 tests pass

## Day 28 delivered

```text
BookingCreatedEvent in packages/contracts (+ parseBookingCreatedEvent)
CreateBooking outbox payload typed against shared contract
bookingCreatedConsumer in flight-notifier (subscribe booking-created, DLQ via Day 21)
Migration 005_add_booking_status (DEFAULT 'active')
BookingRepository.cancel() OCC + releaseSeat
CancelBooking use case + DELETE /api/bookings/:id (204 / 409 / 404)
Double-cancel Promise.all race test
```

## Next

When assigned — next curriculum day (e.g. booking-cancelled consumer, dedupe store, or Saga prelude).

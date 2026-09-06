# CURRENT PROGRESS

**Last completed day:** Day 29
**Current day:** Day 29 — Correlation ID
**Status:** Code complete — correlationId threaded through contracts, outbox, consumers

## Day 29 delivered

```text
correlationId on FlightCreatedEvent + BookingCreatedEvent (envelope, required)
resolveCorrelationId(requestId ?? eventId) shared helper
CreateFlight / CreateBooking / CancelBooking enqueue + audit metadata
flight-notifier consumers log correlationId next to eventId
```

## Next

When assigned — next curriculum day (causationId/Saga, dedupe store, or centralized logging).

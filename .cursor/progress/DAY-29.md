# Day 29 — Session Notes

**Date completed:** 2026-09-06
**Theme:** Correlation ID across api + flight-notifier
**Status:** Completed (code + tests)

## eventId vs correlationId vs causationId

```text
eventId:        identity of ONE outbox row / ONE message (dedupe, stable retries)
correlationId:  identity of the ORIGINATING business flow (today = requestId)
causationId:    NOT added — no event-triggers-event chain yet (Saga later)
```

## Why no new DB column

```text
Outbox payload is already JSON. Adding correlationId to the envelope
rides through enqueue → relay → RabbitMQ → consumer with zero schema change.
```

## Fallback rule

```text
resolveCorrelationId(requestId, eventId) => requestId ?? eventId
No request context (future job) → event correlates with itself.
Shared helper used by CreateFlight, CreateBooking, CancelBooking.
```

## Envelope vs domain payload

```text
{ eventId, correlationId, type, occurredAt, flight|booking }
Envelope fields stay top-level — room for causationId later without touching domain objects.
```

## Investigation workflow (Bước 4)

```text
1. POST with x-request-id (or generated requestId) → that value becomes correlationId
2. Grep api logs for correlationId (audit metadata / requestId)
3. After ~5s outbox relay, grep flight-notifier for same correlationId on *_consumed
Same key stitches both services without guessing timestamps.
```

## Bước 4 — verified evidence (2026-09-12)

```text
correlationId = investigate-002

api (16:24:17):
  request_started / request_finished
  correlationId=investigate-002  statusCode=201
  POST .../bookings

flight-notifier (~2s later, after outbox relay, 16:24:19):
  booking_created_consumed
  correlationId=investigate-002
  eventId=8885a546-8ce6-44c1-a4e2-0c7f288dea42
  bookingId=16fd086a-09d4-4319-b844-8631479762eb

Same key across both processes — no timestamp guessing required.
```

## Quality gate

```text
npm run typecheck && npm run typecheck:test && npm test
All workspace tests pass
```

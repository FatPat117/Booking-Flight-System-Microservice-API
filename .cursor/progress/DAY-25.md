# Day 25 — Session Notes

**Date completed:** 2026-08-22
**Theme:** eventId in flight-created payload (prepare only — no dedupe store)
**Status:** Completed (code)

## Delivered

```text
CreateFlight: eventId = outbox.id, same value in payload (one generateOutboxId() call)
flight-notifier: FlightCreatedEvent + parse validates eventId required, non-empty
flightCreatedConsumer logs eventId in flight_created_consumed
No dedupe store — duplicate delivery still possible, acceptable while handler only logs
```

## Why eventId now, dedupe later

```text
Public event contract — cheap to add early, expensive to change after more consumers.
Handler today only logs — duplicate = duplicate log line, no real harm.
Dedupe store would force flight-notifier persistence (SQLite/Redis) — violates Day 22 boundary without a real side-effect to protect.
Build dedupe when handler has non-idempotent side-effects (email, seat decrement, etc.).
```

## Future dedupe store — design on paper (not implemented)

### 1. Where to store processed eventIds?

```text
SQLite in flight-notifier: simple, durable, matches stack — but adds DB to a worker we kept DB-free (Day 22).
Redis with TTL: fast, natural expiry — extra infra, not in compose today.
Choice today: defer until side-effect exists; lean Redis+TTL if notifier stays stateless, SQLite if we accept local persistence.
```

### 2. How long to keep eventIds?

```text
Not forever — table grows without bound.
TTL aligned with max redelivery window + broker retention (e.g. 7–30 days).
After TTL, very old redelivery could re-run side-effect — trade-off vs storage cost.
```

### 3. Check + side-effect + mark — atomic?

```text
Same dual-write shape as Day 20 producer: side-effect done but mark-failed → duplicate on retry.
Consumer-side Outbox analogue: record "processed" in same transaction as side-effect (when side-effect is DB-backed).
For external side-effects (email): idempotent API keys or outbox-at-consumer pattern — same lesson as Day 24 at producer.
```

## Schema evolution note

```text
Strict eventId validation rejects old queue messages without eventId.
Fresh start: docker compose down -v before deploy, or purge flight-created queue.
```

## Day 24 Bước 6 (carry-over)

```text
Part 1 PASS: RabbitMQ stopped → 201 + outbox row published_at NULL (after app rebuild)
Part 2: start rabbitmq → wait relay → published_at set + notifier log — user to confirm when ready
```

## Quality gate

```text
api: npm test
flight-notifier: npm test
```

## Remaining limitations

```text
No consumer dedupe store
eventId present but not used for skip-duplicate
Duplicate delivery still possible (Day 21 + Day 24 paths)
Shared contract still copied manually (api outbox payload ↔ flight-notifier parse)
```

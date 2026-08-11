# Day 20 — Session Notes

**Date completed:** 2026-08-11
**Theme:** RabbitMQ Producer — first Event-Driven touch
**Status:** Completed

## Real pressure

```text
Day 19: broker runs, app does not talk to it
Day 20: after POST /api/flights succeeds, other systems should be able to learn
         without polling this API — publish flight-created to RabbitMQ
```

## Dual-write (accepted)

```text
SQLite commit and AMQP publish are two systems — not one transaction.
If publish fails after commit: flight exists, message may be lost.
Logged as flight_created_publish_failed; HTTP still returns 201.
Outbox pattern deferred until this pain is felt in practice.
```

## Delivered

```text
MessagePublisher port + createRabbitMqPublisher (durable queue, persistent msgs)
connectWithRetry (10 × 2s, then fail-fast)
RABBITMQ_URL in AppConfig (default localhost; compose uses host rabbitmq)
createApplication async; close() async
CreateFlight async: publish fat flight-created after commit only on "created"
noop publisher for tests
```

## Event payload decision

```text
Fat event: { type, occurredAt, flight }
Reason: inspectable in Management UI; future consumer need not call back yet.
```

## Quality gate

```text
npm run typecheck && npm run typecheck:test && npm run build && npm test
```

## Remaining limitations

```text
No consumer
No exchange/routing
Dual-write / no outbox
No reconnect after broker dies mid-process
```

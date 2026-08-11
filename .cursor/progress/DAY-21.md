# Day 21 — Session Notes

**Date completed:** 2026-08-11
**Theme:** RabbitMQ Consumer — first real read + ack/nack
**Status:** Completed

## Real pressure

```text
Day 20: publish fills flight-created; Ready never decreases without a consumer
Day 21: close the loop with manual ack, still in the same process
```

## Why same process (not a new microservice yet)

```text
Isolate "how ack/nack works" from "how to split services".
A second Composition Root + image + compose service is Day N+1 once mechanics are solid.
```

## Delivered

```text
MessageConsumer port + createRabbitMqConsumer (prefetch 1, manual ack)
flightCreatedConsumer — runtime shape validation, log on processed
Separate AMQP connections for publisher vs consumer (+ shared retry helper)
Wire subscribe on boot; close publisher then consumer then DB
Handler unit tests without RabbitMQ
```

## Design decisions

```text
requeue: false on reject/parse/throw
  — avoid poison-message infinite loops; no DLQ yet
  — trade-off: transient failures drop the message (documented limitation)

Separate AMQP connections
  — independence: one role failing does not tear down the other
  — cost: one extra connection (acceptable at this scale)

Event shape vs domain Flight
  — validate FlightCreatedEvent on the wire, not `as Flight`
  — allows event schema to evolve separately later
```

## At-least-once (experiment note)

```text
If a handler crashes before ack, RabbitMQ keeps the message Unacked,
then redelivers after the consumer channel dies — message may be processed again.
Log-only handler is safe to repeat; DB side-effects would need idempotency later.
```

## Quality gate

```text
npm run typecheck && npm run typecheck:test && npm run build && npm test
```

## Remaining limitations

```text
Consumer + publisher same process
No DLQ / no retry budget
No real idempotent side effects
No multi-service split
```

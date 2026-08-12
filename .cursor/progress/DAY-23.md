# Day 23 — Session Notes

**Date completed:** 2026-08-12
**Theme:** Dead Letter Queue (DLQ) for flight-created
**Status:** Completed — Bước 3 DLQ experiment verified (message + x-death in flight-created.dlq)

## Topology

```text
flight-created (queue, x-dead-letter-exchange → flight-created.dlx)
  └── nack(requeue:false) / parse error / handler throw
        └── flight-created.dlx (fanout)
              └── flight-created.dlq (durable, manual investigation only)
                    └── x-death header: original queue, reason, count, time
```

## Why fanout DLX

```text
Single DLQ destination today; fanout allows binding extra queues later (e.g. alert fan-out)
without changing the dead-letter routing from the main queue.
```

## DLQ scope today (limitation — intentional)

```text
Manual investigation only — no auto-retry, no alerting consumer, no DLQ drain job.
Messages sit in flight-created.dlq until a human uses Management UI (or a future tool).
DLQ only helps if someone checks it; otherwise poison messages are "visible loss" not "silent loss".
```

## Publisher + consumer queue args

```text
Consumer (flight-notifier) declares full topology: DLX + DLQ + bind + main queue.
Publisher (api) asserts DLX + main queue with same x-dead-letter-exchange so assertQueue
does not PRECONDITION_FAILED when notifier created the queue first.
DLQ bind remains consumer-owned (idempotent if consumer starts after publisher).
```

## Upgrade note (existing RabbitMQ volume)

```text
Queue arguments cannot change in place. After adding DLX args:
  docker compose down -v   # wipe rabbitmq_data
  docker compose up --build
Otherwise assertQueue fails with PRECONDITION_FAILED.
```

## Bước 3 experiment (manual)

```text
PASS (user verified): force rejected "test-dlq" → message in flight-created.dlq with x-death
Handler restored to production logic after confirm
```

## Delivered

```text
services/flight-notifier/src/messaging/rabbitmq-consumer.ts — DLX/DLQ assert in subscribe()
src/messaging/rabbitmq-publisher.ts — compatible DLX + queue args on publish
README architecture + limitations updated
noop-message-consumer.ts — already removed Day 22 (N/A)
```

## Quality gate

```text
api: typecheck + build + 134 tests — PASS
flight-notifier: typecheck + build + 2 tests — PASS
docker compose down -v && up --build — PASS (user verified DLX/DLQ topology + Bước 3)
```

## Remaining limitations

```text
No auto-retry / backoff
No DLQ monitoring or alerting
No shared contract package
x-death available for future max-retry logic (not implemented)
```

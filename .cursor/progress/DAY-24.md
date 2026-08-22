# Day 24 — Session Notes

**Date completed:** 2026-08-22
**Theme:** Outbox Pattern — close dual-write limitation from Day 20
**Status:** Completed (code) — Bước 6 manual verify pending

## Problem DLQ did not solve

```text
DLQ protects messages already in the queue.
If RabbitMQ is down at publish time (Day 20 direct publish), the event never reaches the queue —
only flight_created_publish_failed in logs. Outbox fixes the first hop.
```

## Outbox design

```text
CreateFlight: flight + audit + outbox row — ONE SQLite transaction (no MessagePublisher)
OutboxRelay job (5s interval): findUnpublished → publish → markPublished
Publisher still uses RabbitMQ; only the caller changed from use case to relay.
```

## Trade-offs (intentional)

```text
Eventual delivery — publish happens on next relay tick, not in the HTTP request path.
Duplicate delivery if markPublished fails after successful publish — consumer must tolerate retries.
Relay break on first publish failure — preserves order; head-of-line blocking if first row is poison.
No idempotency key in event payload yet.
No CDC/Debezium — SQLite polling is sufficient for learning scale.
```

## Delivered

```text
003_create_outbox migration + idx_outbox_unpublished
OutboxRepository port + SqliteOutboxRepository
CreateFlight writes outbox (messagePublisher removed)
OutboxRelay job registered in JobScheduler (5s default)
Tests: sqlite-outbox-repository, outbox-relay-job, create-flight updated
```

## Bước 6 experiment (manual)

```text
1. docker compose stop rabbitmq
2. POST /api/flights → expect 201; outbox row with published_at NULL
3. docker compose start rabbitmq; wait ~5s
4. outbox row marked published; flight-notifier logs flight_created_consumed
```

## Quality gate

```text
api: typecheck + build + 143 tests — PASS
flight-notifier: npm test — PASS
Bước 6 — user verify RabbitMQ-down self-heal experiment
```

## Remaining limitations

```text
Polling outbox (not CDC)
No idempotency key
markPublished-after-publish duplicate edge case
DLQ still manual-only
```

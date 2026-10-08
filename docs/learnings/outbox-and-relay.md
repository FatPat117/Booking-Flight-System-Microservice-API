# Outbox and relay

## The problem it solves

Saving a flight to Postgres and sending `flight.created` to RabbitMQ are two systems with **no shared transaction**. If the DB commits and the publish then fails (broker down, crash in between), the change exists but the event is lost forever. A dead-letter queue does not help: it only covers messages that already reached the broker.

## How it works

Two halves (full reasoning: `docs/adr/001-outbox-pattern.md`):

**1. Write side — same transaction as the business data**

In `api/src/flights/create-flight.ts`, inside `transactionRunner.run(...)`: save the flight, record the audit row, then `outboxRepository.enqueue(...)`. All commit or all roll back together. The Postgres `enqueue` throws if called outside a transaction (it would silently lose the atomicity guarantee).

**2. Delivery side — a background job reads the table**

`api/src/outbox/outbox-relay-job.ts`, scheduled every 5s (`DEFAULT_OUTBOX_RELAY_INTERVAL_MS` in `bootstrap/application.ts`):

```
findUnpublished(batchSize=20)
for each entry (oldest first):
  publish -> markPublished
  on failure: log outbox_publish_failed, STOP the batch
```

The table is `outbox(id, event_type, payload jsonb, created_at, published_at)` with a partial index on `published_at IS NULL`, so scanning pending rows stays cheap.

## Guarantees and what they cost

- **At-least-once.** `publish` happens *before* `markPublished`. A crash in between republishes the same event, so **consumers must tolerate duplicates** (the `eventId` is the natural idempotency key).
- **Order is preserved per batch.** The `break` on first failure stops later events from overtaking an earlier one that failed.
- **Latency.** Delivery is delayed by up to the polling interval (~5s) — fine here, not for real-time needs.
- **Self-healing.** When the broker returns, pending rows go out on the next tick. Nothing is lost; verified by restarting RabbitMQ and watching `published_at IS NULL` drain.

## Trade-offs / when NOT to use

- Costs an extra table, a polling job and duplicate handling. If losing an event is acceptable (a log line, a cache bust), publishing directly is simpler.
- Polling adds DB load; at high volume you would look at change-data-capture or `LISTEN/NOTIFY` instead. Not needed at this scale.

## Gotchas

- **No publisher confirms yet.** `sendToQueue` returns without waiting for the broker, so if RabbitMQ dies with the message still in the socket buffer, the row can be marked published although it never arrived. A confirm channel (`createConfirmChannel` + wait for confirms) closes this gap — a known limitation to address later.
- Check pending rows:

```sql
SELECT id, event_type, created_at FROM outbox WHERE published_at IS NULL;
```

## Related

- `docs/learnings/lazy-reconnect-publisher.md` — what happens when the broker connection drops
- `docs/learnings/request-tracing-with-async-local-storage.md` — how `correlationId` rides in the payload
- `docs/adr/001-outbox-pattern.md`

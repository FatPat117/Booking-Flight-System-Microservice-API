# ADR-001: Outbox Pattern for Reliable Event Publishing

## Status

Accepted

## Context

The API persists business data in SQLite and notifies other services via RabbitMQ. Those are two systems with **no shared transaction**.

Early messaging published to RabbitMQ inside the HTTP request path after (or alongside) the DB write. If the broker was down or the publish failed after the DB had already committed, the domain change existed but the event never entered any queue. A dead-letter queue only helps messages that **already reached** the broker — it does not protect the first hop when publish never succeeds.

We needed a way to record “we must notify the outside world” atomically with the business write, then deliver asynchronously.

## Decision

Write an outbox row in the **same SQLite transaction** as the business data (and audit). A separate relay job polls unpublished rows, publishes to RabbitMQ, then marks them published.

## Consequences

**Positive**

- No silent loss of “intent to publish” when RabbitMQ is unavailable at request time.
- True atomicity between domain state and the durable intent to emit an event.
- HTTP path stays free of broker latency/failures (relay absorbs retries).

**Trade-offs / costs**

- Delivery is eventual — lag up to the relay interval (~5s by default), not instant in the request.
- If `publish` succeeds but `markPublished` fails, the same event can be delivered again (consumers must tolerate duplicates).
- Extra table, job, and operational surface (poll, ordering, head-of-line blocking on poison rows).
- Still not a distributed transaction across services — only local reliability for the producer side.

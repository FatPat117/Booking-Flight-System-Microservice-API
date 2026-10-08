# Lazy reconnect for the RabbitMQ publisher

## The problem it solves

Before Day 41 the publisher opened one connection at startup and kept it forever. Restarting RabbitMQ left the app alive but holding a **closed channel**: every relay tick logged `outbox_publish_failed ... Channel closed`, `/live` stayed healthy, so Docker's `restart: unless-stopped` never fired. Events stayed in the outbox, stuck until someone restarted `app` by hand.

(Observed in a real run: `RestartCount=0`, rows with `published_at IS NULL`, fixed only by `docker compose restart app`.)

## How it works

`api/src/messaging/rabbitmq-publisher.ts` keeps a `current` session (connection + channel):

- **Detect:** listeners on the connection and channel `close` events call `invalidate(session, reason)`, which clears `current`, logs `rabbitmq_connection_lost`, and closes the leftover connection.
- **Repair lazily:** the next `publish()` finds no `current` and calls `getSession()`, which opens a new session and logs `rabbitmq_reconnected`. There is **no background timer**.
- **Share one attempt:** concurrent publishes reuse a single in-flight `opening` promise.
- **Failure is fine:** if reconnect fails, `publish` throws; the relay logs it, leaves the outbox row alone and tries again on the next tick (the relay's 5s interval *is* the retry cadence).
- **Graceful shutdown:** `close()` sets `isClosing`, clears `current` *before* closing, so our own close events are not logged as "lost", and later publishes reject instead of reconnecting.
- **Identity check:** `invalidate` ignores events from a session that is no longer `current`, so a late close event from an old session cannot drop a newer one.
- Also added `channel.on("error")` — previously missing.

Startup is still fail-fast: the first connect throws and `connectPublisherWithRetry` retries a bounded number of times.

## Why lazy instead of a reconnect loop

The outbox already provides durability and a retry clock. A second retry timer in the publisher would duplicate that logic and add its own state to get wrong. Reconnecting only when something wants to publish keeps the code small, and `rabbitmq_reconnected` appears exactly when it matters.

## Trade-offs / when NOT to use

- Reconnect happens only when there is something to publish; an idle app notices the loss (logged) but reconnects later. Fine here, not for a service that must hold a warm connection.
- A publisher that needs sub-second recovery or its own buffering would want a proper reconnect loop with backoff.
- The consumer (`flight-notifier`) deliberately recovers differently: it crashes and relies on `restart: unless-stopped` plus bounded connect retry.

## How it is tested

`api/tests/rabbitmq-publisher.test.ts` uses a fake connection built on `EventEmitter` that mimics amqplib: `close` fires once, closing an already-closed connection rejects. Four behaviors: reconnect after loss, concurrent publishes share one reconnect, failed reconnect rejects then retries, graceful close is not a loss. Mutation check: removing `current = undefined` in `invalidate` makes 3 of the 4 fail — so the tests catch a real bug.

## Verify against real Docker

```bash
docker compose restart rabbitmq
# create a flight, then:
docker compose logs app | grep -E "connection_lost|reconnected|outbox_publish_failed"
docker inspect -f '{{.RestartCount}}' $(docker compose ps -q app)   # expect 0
```

Expected: `rabbitmq_connection_lost` right after the restart, `rabbitmq_reconnected` when the next flight is created, no unpublished outbox rows.

## Gotchas

- `/ready` does not check RabbitMQ on purpose: failing readiness over a flapping broker could take the whole service out of rotation, while the outbox already tolerates an outage.
- Still no publisher confirms (see `outbox-and-relay.md`).

## Related

- `docs/learnings/outbox-and-relay.md`
- `docs/adr/001-outbox-pattern.md`

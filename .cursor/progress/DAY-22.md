# Day 22 — Session Notes

**Date completed:** 2026-08-12
**Theme:** First microservice split — flight-notifier
**Status:** Completed

## Service boundary (flight-notifier needs / does not need)

```text
NEEDS: RabbitMQ consumer, Logger, FlightCreatedEvent contract, SIGTERM/SIGINT shutdown
NOT:   Express, SQLite, FlightRepository, JobScheduler, MessagePublisher
```

## Why copy code (B) not monorepo (A)

```text
Small shared surface (~few files), no workspace tooling yet.
Cost: FlightCreatedEvent must be updated in api publish shape + notifier parse — documented.
```

## Healthcheck decision

```text
No HTTP in flight-notifier → no fake /live endpoint.
Use restart: unless-stopped + rely on process exit if Node dies.
Trade-off: cannot distinguish "process up but AMQP dead" without extra probe (deferred).
```

## Delivered

```text
services/flight-notifier/ — standalone package, Dockerfile, tests
api: publisher only; consumer files removed from src/
docker-compose: app + flight-notifier + rabbitmq
```

## Day 21 review notes (confirmed)

```text
try/catch around handler() in rabbitmq-consumer — present in flight-notifier copy
Bước 6 Unacked experiment — run manually via compose + Management UI when verifying
```

## Quality gate

```text
api: typecheck + build + 134 tests — PASS
flight-notifier: typecheck + build + 2 tests — PASS (tsconfig types: ["node"] fix)
docker compose up --build (3 services) — PASS (user verified)
Bước 6 independence experiments — PASS (user verified):
  stop app → flight-notifier still Up; manual publish via Management UI works
  start app → new flight reaches notifier without notifier restart
  restart flight-notifier → GET /live on app unaffected
```

## Remaining limitations

```text
No shared contract package
Duplicate event contract in two repos
(DLQ added Day 23)
```

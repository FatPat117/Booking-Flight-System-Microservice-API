# Day 19 — Session Notes

**Date completed:** 2026-08-10
**Theme:** docker-compose — multi-container orchestration (app + RabbitMQ)
**Status:** Completed

## Real pressure

```text
Day 18: one image, docker run by hand
Day 19: need app + broker together — manual docker network/run does not scale
```

## Why no RabbitMQ client code yet

```text
Confirm infrastructure first (compose, network, UI, health).
Mixing compose bugs with amqplib bugs makes every failure ambiguous.
```

## Delivered

```text
docker-compose.yml — app (build Dockerfile) + rabbitmq:3-management
depends_on rabbitmq condition: service_healthy
volumes: booking_data, rabbitmq_data
healthchecks for both services
README compose + Management UI + DNS notes
No application code changes / no amqplib
```

## Network mental model

```text
Host → localhost:3000 (app), localhost:15672 (UI)
App container → hostname "rabbitmq" on compose DNS (Day 20 connection string)
```

## Quality gate

```text
docker compose up --build
both services healthy
GET /live → 200
Management UI → 200
getent hosts rabbitmq from app → IP
npm test → 129 pass (no app code changes)
```

## Remaining limitations

```text
App does not publish/consume yet
Default guest/guest only for local compose
```

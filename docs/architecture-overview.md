# Architecture Overview

Learning project status after Day 29 (messaging + correlation). Day 30 documents decisions; it does not change runtime topology. Storage lines updated on Day 41 (api moved SQLite → Postgres on Day 40, SQLite removed Day 41) and Day 42 (identity moved off the Postgres cluster superuser); the rest is still the Day 29 snapshot.

## Current topology

```text
                    ┌─────────────────────────────────────┐
  Client/Postman ──►│  api (Express HTTP)                 │
                    │  Composition Root → use cases       │
                    │  Postgres booking_db (flights,      │
                    │    bookings, audit, outbox)         │
                    │  OutboxRelay job → RabbitMQ publish │
                    └─────────────────┬───────────────────┘
                                      │ default exchange
                                      │ sendToQueue(event-type)
                                      ▼
                               ┌─────────────┐
                               │  RabbitMQ   │
                               │  + *.dlx/dlq│
                               └──────┬──────┘
                                      │ consume
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  flight-notifier (no HTTP)            │
                    │  flight-created / booking-created     │
                    │  parse via @booking-flight-system/    │
                    │  contracts + structured logs          │
                    └─────────────────────────────────────┘

  packages/contracts  — FlightCreatedEvent, BookingCreatedEvent
                        (+ eventId, correlationId envelopes)
```

**Local dev (see `Dev.md`):** RabbitMQ in Docker; `api` and `flight-notifier` via `npm run dev`.
`identity` (Day 31+, not pictured above — still one API process, pre-dates this diagram) also
runs via `npm run dev`, against the same Postgres container, its own `identity_db`.

**Postgres roles (Day 42):** one container, two logical databases, two dedicated non-superuser
roles — `identity` owns `identity_db`, `booking` owns `booking_db`. Neither can `CONNECT` to the
other's database (`REVOKE CONNECT ... FROM PUBLIC`, `docker/postgres-init/`). The cluster
superuser is a third, separate identity, used only by the init scripts at container bootstrap —
no application ever authenticates as it. Before Day 42, `identity` *was* that superuser by
accident (its env var names collided with the Postgres image's own bootstrap vars), which made
the `booking_db` isolation above one-directional; both directions are now real and covered by an
integration test per service (`tests/integration/not-superuser.integration.test.ts`).

## Decision highlights

| Concern | Choice | ADR |
|---------|--------|-----|
| Reliable publish | Transactional outbox + relay | [001](./adr/001-outbox-pattern.md) |
| Shared event shapes | npm workspaces + `packages/contracts` | [003](./adr/003-npm-workspaces-shared-contracts.md) (supersedes [002](./adr/002-copy-code-over-monorepo.md)) |
| Contested writes | Conditional UPDATE (OCC) | [004](./adr/004-optimistic-concurrency-control.md) |
| Cross-service investigation | `correlationId` (= `requestId` when present) | Day 29 progress notes |

## Gap vs destination architecture

Destination reference: sibling / target style of `meysamhadeli/booking-microservices-expressjs` (Identity, Flight, Passenger, Booking, Postgres, CQRS, Saga, JWT, OpenTelemetry, etc.). This table is honest about **what we have**, not a to-do list to rush.

| Destination capability | Here now? | Why not yet (or how far) |
|------------------------|-----------|---------------------------|
| Single Express API | ✅ | Learning path started here |
| REST + validation + auth | ✅ | Manual validation; single shared API key (not JWT/OAuth/RBAC) |
| Persistence + Repository | ✅ | Postgres/TypeORM behind repository ports (Day 36–41; was `node:sqlite`) |
| Dependency Injection | ✅ partial | Manual Composition Root only — graph still small; container DI not earned |
| Background jobs | ✅ | In-process scheduler; no durable job store / multi-instance safety |
| RabbitMQ + consumers | ✅ | Default exchange + per-queue DLX/DLQ; not a full broker topology/catalog |
| Event-driven flow | ✅ | Outbox + fat events; no CDC |
| Shared contracts package | ✅ | npm workspaces; not Nx |
| Correlation across services | ✅ | Field + headers/logs; not W3C Trace / OpenTelemetry |
| CQRS | ❌ | Read/write traffic and models still fit one path; no skew that forces separate models |
| Saga (multi-service compensate) | ❌ | Cancel booking compensates **inside** one DB/service; no cross-service undo chain |
| Consumer dedupe store | ❌ | `eventId` exists; durable idempotency store not built |
| causationId / event chains | ❌ | Events are HTTP-rooted, not event-triggers-event |
| Centralized metrics/alerting | ❌ | Console structured logs + `/live` `/ready`; no ELK/Prometheus/PagerDuty |
| Multi-service domains (Identity, Passenger, …) | ❌ | Still one API process + one notifier; split when bounded contexts hurt |
| Production-ready | **Partial** | See below |

## Production-ready? (honest)

**Have:** typed config, migrations, health/readiness, auth on writes, transactions, outbox, DLQ, Docker Compose, correlation headers/logs, automated tests, least-privilege Postgres roles (Day 42).

**Missing for real production:** secrets management & key rotation, multi-instance job/outbox safety, durable consumer idempotency, observability beyond console, stronger authz, load/chaos testing, runbooks/alerts, zero-downtime migration story.

We are **past “toy CRUD”** and **short of “ship to paying customers at scale.”** That gap is intentional — fill only when a real pressure appears.

## Open question (keep asking)

Looking at the “❌” rows: is there **real pressure today**, or are they still correctly deferred? Prefer solving demonstrated pain over closing the table for symmetry with a reference repo.

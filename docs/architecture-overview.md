# Architecture Overview

Learning project status after Day 29 (messaging + correlation). Day 30 documents decisions; it does not change runtime topology.

## Current topology

```text
                    ┌─────────────────────────────────────┐
  Client/Postman ──►│  api (Express HTTP)                 │
                    │  Composition Root → use cases       │
                    │  SQLite (flights, bookings, audit,  │
                    │          outbox)                    │
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
| Persistence + Repository | ✅ | `node:sqlite`, not Postgres/TypeORM |
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

**Have:** typed config, migrations, health/readiness, auth on writes, transactions, outbox, DLQ, Docker Compose, correlation headers/logs, automated tests.

**Missing for real production:** secrets management & key rotation, multi-instance job/outbox safety, durable consumer idempotency, observability beyond console, stronger authz, Postgres operational practices, load/chaos testing, runbooks/alerts, zero-downtime migration story.

We are **past “toy CRUD”** and **short of “ship to paying customers at scale.”** That gap is intentional — fill only when a real pressure appears.

## Open question (keep asking)

Looking at the “❌” rows: is there **real pressure today**, or are they still correctly deferred? Prefer solving demonstrated pain over closing the table for symmetry with a reference repo.

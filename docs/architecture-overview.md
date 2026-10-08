# Architecture Overview

Learning project status after Day 29 (messaging + correlation). Day 30 documents decisions; it does not change runtime topology. Storage lines updated on Day 41 (api moved SQLite → Postgres on Day 40, SQLite removed Day 41) and Day 42 (identity moved off the Postgres cluster superuser); the gap table was re-mapped to roadmap phases on Day 42B; the rest is still the Day 29 snapshot.

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

Destination reference: sibling / target style of `meysamhadeli/booking-microservices-expressjs` (Identity, Flight, Passenger, Booking, Postgres, CQRS, Saga, JWT, OpenTelemetry, etc.). This table records **what we have** and **which roadmap phase closes each gap**. The phases are defined in [roadmap.md](./roadmap.md); this table does not repeat them.

| Destination capability | Here now? | Current state | Phase |
|------------------------|-----------|---------------|-------|
| Single Express API | ✅ | Learning path started here | A |
| REST + validation + auth | ✅ | Manual validation; JWT from Identity with an `admin` role (Day 34) | A/B; validation library in H |
| Persistence + Repository | ✅ | Postgres/TypeORM behind repository ports (Day 36–41; was `node:sqlite`) | B |
| Dependency Injection | ✅ partial | Manual Composition Root only | Container (tsyringe) in E |
| Background jobs | ✅ | In-process scheduler; no durable job store / multi-instance safety | — (revisit when multiple instances run) |
| RabbitMQ + consumers | ✅ | Default exchange + per-queue DLX/DLQ; not a full broker topology/catalog | F |
| Event-driven flow | ✅ | Outbox + fat events; no CDC | — |
| Shared contracts package | ✅ | npm workspaces; not Nx | — |
| Correlation across services | ✅ | Field + headers/logs; not W3C Trace | G |
| Complete booking domain | ❌ | Flights + single-passenger bookings only; no airports, aircraft, seat maps, payment | **D** |
| CQRS + Mediator | ❌ | ~5 use cases share one model — assessed at the start of E, against the full domain | E |
| Saga (multi-service compensate) | ❌ | Cancel booking compensates **inside** one DB/service | F |
| Consumer dedupe store (Inbox) | ❌ | `eventId` exists; durable idempotency store not built | F |
| causationId / event chains | ❌ | Events are HTTP-rooted, not event-triggers-event | F |
| Multi-service domains (Passenger, Flight, Booking) | ❌ partial | Identity + notifier split; Flight/Booking still in `api` | F |
| Centralized metrics/tracing | ❌ | Console structured logs + `/live` `/ready` | G |
| Production-ready | **Partial** | See below | H |

## Production-ready? (honest)

**Have:** typed config, migrations, health/readiness, auth on writes, transactions, outbox, DLQ, Docker Compose, correlation headers/logs, automated tests, least-privilege Postgres roles (Day 42).

**Missing for real production:** secrets management & key rotation, multi-instance job/outbox safety, durable consumer idempotency, observability beyond console, stronger authz, load/chaos testing, runbooks/alerts, zero-downtime migration story.

We are **past “toy CRUD”** and **short of “ship to paying customers at scale.”** That gap is intentional — fill only when a real pressure appears.

## Open question (keep asking)

Each “❌” row now has a phase, but a phase is not a license to build the pattern regardless. At the start of each phase, confirm there is **real pressure** (or an explicitly stated non-technical reason) before closing a row. See the principles in [roadmap.md](./roadmap.md).

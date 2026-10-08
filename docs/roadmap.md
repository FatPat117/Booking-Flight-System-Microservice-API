# Roadmap

**This is the only file that holds the detailed roadmap.** `CLAUDE.md`, `.cursor/progress/CURRENT.md`, `README.md` and `docs/architecture-overview.md` only summarize it and link here. When the plan changes, edit this file and add a line to [Roadmap history](#roadmap-history). Why the order changed belongs in an ADR, not here.

## Goal

The goal is a complete flight-booking system that a reviewer, such as a hiring manager, can read end to end.

- **Architecture:** the target architecture of the reference repo (`meysamhadeli/booking-microservices-expressjs`).
- **Domain:** a domain deep enough to be a real product, not a CRUD demo.
- **Timeline:** taking well past Day 100 is acceptable.

## Principles

- **Monolith first.** The domain is completed inside `api` before Flight and Booking are split into separate services. The split comes once the boundaries have been exercised by real use cases, not guessed up front.
- **Patterns need evidence.** An advanced pattern (CQRS, Mediator, Saga, …) is introduced only when either:
  - the codebase shows the pain it solves, or
  - there is an explicitly stated non-technical reason (e.g. portfolio value), written down as such.

## Definition of "complete"

A feature counts as complete only when all of these hold:

1. Its business rules are written down.
2. It has unit tests (fakes) and integration tests (Postgres).
3. It has a race test, if it writes contested data.
4. Every event it emits goes through the outbox.
5. It appears in the Postman collection and the docs.

## Standing disciplines

These carry over unchanged into every phase:

- Ports that can touch I/O are `Promise`-based from day one.
- Every new port gets a contract test (fake and Postgres adapter, [ADR-005](./adr/005-test-strategy-fakes-and-postgres-integration.md)).
- Database semantics are tested on real Postgres.
- OCC via conditional `UPDATE` for contested data ([ADR-004](./adr/004-optimistic-concurrency-control.md)).
- Every new event goes through the outbox ([ADR-001](./adr/001-outbox-pattern.md)).
- Large decisions get an ADR.
- Test counts are reconciled whenever tests are removed.

## Phases

### Done

| Phase | Days | What it built |
|---|---|---|
| **A. Foundations → messaging** | 1–30 | Express API, validation, tests, error envelope, persistence, repository + use cases, config, pagination, observability, health checks, auth, audit, transactions, migrations, Composition Root, jobs, Docker, RabbitMQ, outbox, DLQ, booking with OCC, npm workspaces, correlation IDs, ADRs |
| **B. Identity + Postgres** | 31–42 | Identity service, JWT login and verification, admin role, `api` migrated SQLite → Postgres/TypeORM (strangler fig, [ADR-006](./adr/006-sqlite-to-postgres-migration.md)), test strategy without SQLite, least-privilege Postgres roles |

### Ahead

**D. Complete domain inside `api`** (Day 43 → around Day 65)

- Day 43: define the product scope and the domain model (no code).
- Airports and aircraft.
- Flight schedule, flight status lifecycle, flight search.
- Seat map, seat selection, time-limited seat holds.
- Bookings:
  - multi-passenger bookings with a PNR code
  - booking lifecycle and ownership rules
  - cancellation policy
  - seat change
- Simulated payment with `Idempotency-Key`.
- Cascading cancellation when a flight is cancelled.
- Admin operations.

**E. CQRS + Mediator + Vertical Slice + DI container (tsyringe)**

- Opens with the CQRS/Mediator assessment that used to be planned for Day 43. By then it is made against the full phase-D domain.

**F. Service split**

- Passenger, Flight and Booking become separate services.
- Synchronous REST plus asynchronous events between them.
- Saga for cross-service workflows.
- Inbox pattern (durable consumer idempotency).

**G. Observability**

- OpenTelemetry, Jaeger, Prometheus, Grafana.

**H. Production-ready + portfolio**

- Joi validation, Swagger/tsoa, testcontainers, CI.
- Rate limiting, load testing.
- Refresh tokens.
- Deployment, demo documentation.

## Decisions deferred until they are reached

- Jest vs. staying on `node:test`. Decided at H, alongside testcontainers.
- MediatrJs vs. a hand-written mediator. Decided at E.
- API Gateway (optional). Decided at F.

## Roadmap history

Each change was made because of evidence found while building, not as a reshuffle.

| When | Change | Why |
|---|---|---|
| Day 5–19 | Original plan: one feature per day, Day 19+ RabbitMQ | Each step was triggered by a pain the previous day exposed (e.g. Day 16 DI before jobs/broker made the object graph explode) |
| Day 31 | Postgres arrived early, for the new Identity service only, not `api` | A new service had no SQLite history to migrate, so it could start on the destination database cheaply |
| Day 35 | Strangler fig changed from "cut over per table" to "dev-complete each adapter, cut over once" | The four tables share one transaction boundary, so a per-table cutover would have broken atomicity |
| Day 40 → 41 | Cutover and SQLite deletion split into two days | Rollback had to stay a single `git revert`, and the test strategy without SQLite had to be decided first |
| Day 42B | The old "Group C = CQRS + Mediator, starting Day 43" replaced by phase D (domain first); CQRS moved to the start of E | Only ~5 use cases exist, too few to judge CQRS on evidence, and splitting services before the domain is stable risks a distributed monolith ([ADR-007](./adr/007-domain-before-advanced-patterns.md)) |

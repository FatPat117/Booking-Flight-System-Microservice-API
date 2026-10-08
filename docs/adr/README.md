# Architecture Decision Records (ADR)

This folder records **long-lived architecture decisions** — not day-by-day learning notes.

| Document type | Purpose |
|---------------|---------|
| `.cursor/progress/DAY-XX.md` | Process log: what we built that day and why, in chronological order |
| `docs/adr/*.md` | Decision record: one durable choice, context, trade-offs — readable by someone who never followed the course |

## Format

Each ADR follows the common Michael Nygard style:

- **Status** — `Proposed` · `Accepted` · `Superseded by ADR-XXX` · `Deprecated`
- **Context** — what forced the decision (pressures / constraints at that time)
- **Decision** — one clear sentence of what we chose
- **Consequences** — gains **and** costs (both required)

ADRs do **not** describe how to implement the choice. That lives in code and day notes.

## Index

| ADR | Title | Status |
|-----|--------|--------|
| [001](./001-outbox-pattern.md) | Outbox Pattern for Reliable Event Publishing | Accepted |
| [002](./002-copy-code-over-monorepo.md) | Copy Shared Types Instead of Monorepo Tooling | Superseded by [003](./003-npm-workspaces-shared-contracts.md) |
| [003](./003-npm-workspaces-shared-contracts.md) | Adopt npm Workspaces for Shared Contracts | Accepted |
| [004](./004-optimistic-concurrency-control.md) | Optimistic Concurrency Control via Conditional UPDATE | Accepted |
| [005](./005-test-strategy-fakes-and-postgres-integration.md) | Unit Tests on In-Memory Fakes, Database Semantics on Real Postgres | Accepted |
| [006](./006-sqlite-to-postgres-migration.md) | Move `api` Storage from SQLite to Postgres/TypeORM | Accepted |
| [007](./007-domain-before-advanced-patterns.md) | Complete the Domain Before Introducing Advanced Patterns | Accepted |

See also: [architecture overview](../architecture-overview.md) — current topology and gap vs the destination architecture.

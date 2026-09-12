# ADR-003: Adopt npm Workspaces for Shared Contracts

## Status

Accepted

Supersedes [ADR-002](./002-copy-code-over-monorepo.md).

## Context

After booking was introduced, `booking-created` was queued and a second consumer was imminent. Keeping ADR-002’s copy approach meant duplicating every new event type (and every field change) across packages by hand. The sync tax scales with **event types × consumers**, not with “one more file.”

We already had two deployable Node packages (`api`, `flight-notifier`). The missing piece was a **single compile-time source of truth** for cross-service payloads — without adopting a heavy monorepo orchestrator (Nx/Turborepo) for three packages.

## Decision

Use **npm workspaces** at the repo root (`api`, `services/*`, `packages/*`) and publish shared event contracts from `@booking-flight-system/contracts`. Producers type-check outbox payloads against those types; consumers import shared parse functions. Only types that have **≥2 sides** belong in the package (YAGNI for publisher-only events).

## Consequences

**Positive**

- One place to change event shape; TypeScript catches producer/consumer mismatch at build time.
- Marginal cost of a new shared event drops to “add file + import” once workspace/Docker order exists.
- Encourages keeping internal helpers (logger, retry) **out** of contracts — only cross-service agreements live there.

**Trade-offs / costs**

- Docker build context moved from each service folder to **repo root** — Dockerfiles must COPY workspace manifests + build contracts before dependents.
- Fresh clones need root `npm install` (postinstall builds contracts); easy to confuse with per-package install.
- A large cutover (many imports) is a real risk window; we paid that once when reversing ADR-002.
- Still no Nx/Turborepo — fine at three packages; revisit if build graph pain appears.

# Day 27 — Session Notes

**Date completed:** 2026-08-23
**Theme:** Shared contract package via npm workspaces
**Status:** Completed (code + tests + docker build)

## Why reverse Day 22 "copy code" decision now

```text
Day 22: one event type, tiny shared surface → copy cheaper than monorepo overhead.
Day 26+: booking-created queued, consumer coming → cost scales with (event types × consumers).
Second duplicate type (BookingCreatedEvent) would repeat the same manual-sync tax.
Evidence changed the trade-off — not preference for monorepo theory.
```

## Delivered

```text
npm workspaces root: api, services/*, packages/*
packages/contracts (@booking-flight-system/contracts): FlightCreatedEvent + parseFlightCreatedEvent
api: import type FlightCreatedEvent for outbox payload (compile-time contract check)
flight-notifier: import parseFlightCreatedEvent from shared package
Deleted duplicate flight-created-event.ts in flight-notifier
Docker: build context → repo root; contracts built before dependent services
postinstall builds contracts locally; Docker uses --ignore-scripts + explicit build order
```

## What did NOT go into contracts (intentional)

```text
Logger, connect-with-retry — internal implementation per service, not a cross-service contract.
BookingCreatedEvent — no consumer yet; YAGNI until second side exists.
```

## Docker build context trade-off (real cost of monorepo)

```text
Before: context = service folder → self-contained COPY.
After: context = repo root → must COPY workspace package.json files + contracts source.
Must build contracts before api/flight-notifier (dependency order).
Runtime stage: npm ci --ignore-scripts (dist copied from build stage; no tsc in prod).
.dockerignore excludes tests, nested node_modules, markdown — keeps context lean.
```

## Scoped package name

```text
@booking-flight-system/contracts — namespace avoids collision with public npm packages;
room for test-utils, etc. later without naming ambiguity.
```

## Quality gate

```text
npm run typecheck && npm run typecheck:test && npm test  (root — all workspaces)
157 tests pass (155 api + 2 flight-notifier)
docker compose build — PASS
```

## Adding domain 3 event (with workspace vs Day 22)

```text
Day 22: copy type + parse to each consumer, update N places on every field change.
Day 27+: add file to packages/contracts, bump import in publisher + consumer — one source of truth.
Docker pattern already established; marginal cost is low.
```

## Remaining limitations

```text
booking-created still no shared contract (no consumer)
No Turborepo/Nx — 3 packages, not needed yet
Root postinstall builds contracts — fresh clone needs npm install at root (not per-package)
```

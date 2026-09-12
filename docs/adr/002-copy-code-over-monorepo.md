# ADR-002: Copy Shared Types Instead of Monorepo Tooling

## Status

Superseded by [ADR-003](./003-npm-workspaces-shared-contracts.md)

## Context

When the first consumer service (`flight-notifier`) was split out, only **one** event type (`FlightCreatedEvent`) crossed the process boundary. The shared surface was tiny: a TypeScript type plus a runtime parser.

Introducing npm workspaces, a shared package, and root Docker build context at that moment meant paying monorepo overhead for a single duplicated file. The immediate pain was “get a second process consuming messages,” not “sync N event contracts.”

## Decision

Copy `FlightCreatedEvent` (and its parser) into `flight-notifier` instead of extracting a shared package or adopting monorepo tooling.

## Consequences

**Positive (at the time)**

- Fastest path to a working second service.
- No Docker/workspace refactor while learning messaging and DLQ.
- Clear ownership: each service could run from its own folder context.

**Trade-offs / costs**

- Two sources of truth for the same contract — field changes required manual sync.
- Easy to drift (producer and consumer disagree silently until runtime reject/DLQ).
- Cost would grow with each new `(event type × consumer)` pair — acceptable only while that product was still 1×1.

This decision was **correct for that scale**, not a permanent preference. Evidence later (second domain events) reversed the trade-off — see ADR-003.

# Day 30 — Session Notes

**Date completed:** 2026-09-12
**Theme:** Architecture Decision Records (ADR) + architecture overview
**Status:** Completed (docs only — no product code)

## Delivered

```text
docs/adr/README.md
docs/adr/001-outbox-pattern.md                         Accepted
docs/adr/002-copy-code-over-monorepo.md                Superseded by 003
docs/adr/003-npm-workspaces-shared-contracts.md        Accepted
docs/adr/004-optimistic-concurrency-control.md         Accepted
docs/architecture-overview.md                          topology + gap table
```

## Intent

```text
Compress DAY-XX process logs into durable decision records for future readers.
Preserve superseded history (002 → 003) instead of rewriting the past as if copy never happened.
Honest gap analysis vs destination architecture — Production Ready = partial.
```

## Day 29 Bước 4 (closed 2026-09-12)

```text
PASS — investigate-002 matched on api request_finished and
flight-notifier booking_created_consumed (~2s apart via outbox relay).
Evidence recorded in DAY-29.md.
```

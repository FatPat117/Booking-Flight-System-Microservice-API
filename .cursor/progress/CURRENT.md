# CURRENT PROGRESS

**Last completed day:** Day 42B
**Current day:** Day 42B — new roadmap locked in, docs synced to it (no code)
**Status:** Closed — the roadmap now lives in one place, [`docs/roadmap.md`](../../docs/roadmap.md);
`CLAUDE.md`, README, `docs/architecture-overview.md`, `.cursor/progress/ROADMAP.md` and
`learning-philosophy.mdc` only summarize and link to it. The order change (domain first, CQRS
later) is recorded as ADR-007. `CLAUDE.md`'s stale "Quick snapshot" (still Day 19) was removed
and its Code organization / testing sections were corrected for Day 41 (no more `sqlite-*`).

**Roadmap change:** the old "Group C — CQRS + Mediator assessment on Day 43" is gone. Phase D
(complete the domain inside `api`) comes first; the CQRS/Mediator assessment now opens phase E.

## Day 42B delivered

```text
Step 1: grep inventory of every place describing the old roadmap (9
  locations: 7 fixed, 2 left as historical day logs) — DAY-42B.md
Step 2: docs/roadmap.md — goal, principles, definition of "complete",
  standing disciplines, phases A/B (done) and D–H, deferred decisions,
  roadmap history with the evidence behind each change
Step 3: ADR-007 (domain before advanced patterns) with four real costs
Step 4: CLAUDE.md, CURRENT.md, README, architecture overview,
  ROADMAP.md, learning-philosophy.mdc turned into summaries + links;
  no product code touched
```

## Previous day (Day 42) recap

```text
identity moved off the Postgres cluster superuser (dedicated NOSUPERUSER
role, REVOKE CONNECT both directions, not-superuser integration test per
service); Group B (Day 31 → 42) closed with a retrospective.
```

## Next

Day 43 — Define the product scope and the domain model (no code): the first day of phase D in
[`docs/roadmap.md`](../../docs/roadmap.md).

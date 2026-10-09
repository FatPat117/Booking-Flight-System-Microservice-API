# CURRENT PROGRESS

**Last completed day:** Day 43
**Current day:** Day 43 — product scope + domain model for phase D (no code)
**Status:** Closed — [`docs/product/scope.md`](../../docs/product/scope.md) (actors, glossary,
22 user stories, Won't) and [`docs/product/domain-model.md`](../../docs/product/domain-model.md)
(aggregates, lifecycles, 30 coded business rules, permissions, gap vs current code, phase-D
order) written. README cleaned of day-stamped headings and stale content. Roadmap phase D
links to both files. No product code touched.

## Day 43 delivered

```text
Step 0: README — headings without days; auth/audit/compose/messaging/
  limitations corrected against app.ts; booking endpoints flagged as an
  unauthenticated known gap; broken Location header noted
Steps 1–2, 7: scope.md — actors, glossary (Seat vs FlightSeat, Account vs
  Passenger), 22 stories with MoSCoW and failure criteria, 12 Won't items
Steps 3–6: domain-model.md — seat inventory on the Flight side,
  all-or-nothing holds, derived availability, price snapshots, VND only,
  404 for other accounts' bookings, payment-vs-expiry race, 7 breaking
  changes listed, 10-step phase-D order
```

## Previous day (Day 42B) recap

```text
Roadmap moved to a single source (docs/roadmap.md); ADR-007 records domain
before CQRS/Mediator; CLAUDE.md, README, overview, ROADMAP.md and the
learning-philosophy rule turned into summaries + links.
```

## Next

Day 44 — Booking ownership (phase D step 1): booking endpoints require a `user` JWT, the
booking's owner is the token's `sub`, owners list/view only their own bookings, and another
account's booking answers `404` (BR-AUTH-01/02, US-BOOK-02/03 in
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order)).

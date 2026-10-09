# Day 43 — Session Notes

**Date:** 2026-10-09
**Theme:** Define the product scope and the domain model for phase D (no code)
**Status:** Completed — docs/product/scope.md + docs/product/domain-model.md written, README cleaned,
roadmap phase D points at them. No product code touched.

## Why a whole day before any phase-D feature

```text
Days 1–42 went mostly into infrastructure; the domain is a Flight with an
availableSeats counter and a Booking with a free-text passengerName. Phase D
changes the data model itself (availableSeats becomes derived, passengerName
becomes a table, bookings gain owners), and that is expensive to discover
mid-feature. Deciding it on paper first is the cheap version.
```

## Step 0 — README cleanup (carried over from Day 42B)

```text
Day-stamped headings removed. Stale content fixed: architecture (identity +
postgres), authentication (endpoint/credential table; booking endpoints
flagged as an unauthenticated known gap), audit trail (3 actions, actor
labels as they really are), composition root, docker build/CMD paths,
compose topology, messaging (3 event types, per-queue DLQ), application
flow, scripts (test:integration). Current limitations rewritten to 16 lines,
each true at commit time.
Found while cross-checking app.ts: POST .../bookings returns a Location
header for a GET route that does not exist.
```

## Decisions (user)

```text
Multi-seat hold is all-or-nothing (409 SEATS_UNAVAILABLE listing the lost
  seats) — families want to sit together; no "short of seats" state.
Seat status lives on the Flight side (FlightSeat inventory), not in Booking
  — "sold at most once" is a rule about the flight's inventory; keeps the
  ADR-004 conditional-UPDATE shape; Flight needs it for seat map / load
  factor / cascade. In phase F the Flight service owns it.
Numbers: hold 15 min, sales close 1 h before departure, no owner
  cancellation within 24 h of departure, 1–9 passengers, VND only (integer
  minor units).
FareClass = ECONOMY / BUSINESS, one fare per class per flight; a seat change
  across classes is 422 (price difference out of scope).
Simulated payment: client chooses success/decline; same Idempotency-Key with
  a different body is 422 IDEMPOTENCY_KEY_REUSED.
Seat map shows AVAILABLE / HELD / BOOKED (changed from Claude's proposal of
  hiding HELD). Agreed reason is UX — a frontend can tell "may free up in 15
  minutes" from "sold". Recorded honestly: it does not reduce races; the map
  is a snapshot and the conditional UPDATE still decides.
Aircraft cannot operate two overlapping flights (BR-FLT-03).
Find-by-reference is owner-only (Should); guest lookup by PNR + name left out.
First phase-D feature (Day 44) = booking ownership.
```

## Decisions (proposed by Claude, accepted on review)

```text
Someone else's booking -> 404, identical to "does not exist" (BR-AUTH-02):
  403 would confirm the id exists — the Day 32 enumeration lesson.
Booking prices are a snapshot at hold time; availableSeats becomes derived
  from FlightSeat rows (no second copy of the truth).
Seat vs FlightSeat and Account vs Passenger are separate glossary terms;
  code never names a FlightSeat "seat".
Payment has no PENDING state (synchronous simulator).
Admins read everything but do not create or pay bookings for others.
```

## Output

```text
docs/product/scope.md: 4 actors, 19-term glossary, 22 user stories
  (14 Must, each with success and failure criteria, Given/When/Then),
  12 Won't items each with a one-sentence reason.
docs/product/domain-model.md: entities + value objects, relationship
  diagram, 5 aggregates with invariants, 5 decisions, phase-F note,
  lifecycles for Flight / FlightSeat / Booking / Payment (terminal states,
  forbidden transitions, payment-vs-expiry race), 30 coded rules (BR-*),
  permission matrix, gap table (7 breaking changes) + expand/backfill/
  contract note, 10-step phase-D order with a reason per step.
docs/roadmap.md: phase D summarized, links to both files (no copy of the
  order — it lives in domain-model.md).
Checked by script: no duplicate US-/BR- ids, every referenced BR- id is
  defined, every relative link resolves.
```

## Not today

```text
BR-FLT-03 (no overlapping flights per aircraft) races between concurrent
  admins — needs a DB-level guard (e.g. exclusion constraint); decided on
  the day it is built.
Existing api accepts USD and names the column priceInCents — both change
  with the Money/fare-class step.
Guest booking lookup (PNR + last name), saved passenger profiles — not
  scoped.
Payment-vs-expiry race test and multi-seat hold race tests are planned for
  steps 5–6, not written.
```

## DAY 43 SUMMARY

```text
Phase D now has a written contract before any code: who the system serves,
the 22 stories it must satisfy, and the 12 things it deliberately won't do.
The domain model fixes the hard choices up front — seat inventory on the
Flight side, all-or-nothing holds, derived availability, price snapshots,
404 for other people's bookings — and names every rule with an ID that tests
will reference. The gap table shows seven breaking changes to today's model,
which is why phase D starts with the cheap, independent fix (booking
ownership) and saves the biggest change (FlightSeat inventory) for when its
prerequisites exist.
```

# ADR-011: Cancel a Flight in One Short Transaction, Cascade Its Bookings with a State-Driven Job

## Status

Accepted (Day 52)

## Context

Cancelling a flight (US-OPS-01, BR-FLT-07) must end every live booking on it: release its seats, refund the paid ones, and tell each customer. On a full narrow-body flight that is up to ~200 bookings, each with seats, maybe a payment, an audit entry and an event: hundreds of writes, not one `UPDATE`.

Two shapes were possible:

- **A — one transaction.** Lock the flight, cancel every booking, release every seat, move every payment to `REFUND_PENDING`, commit. Atomic, no in-between state. But the transaction holds the flight row and every seat and booking of the flight for its whole run, so every hold, payment and expiry on that flight waits behind it (the lock-duration lesson of Day 39). It also locks the flight **before** its seats, while the hold statement locks seats and then shares the flight: the cycle the Day 47 review predicted. A crash rolls everything back and the admin must try again.
- **B — a short status change, then a cascade.** One short transaction moves the flight to `CANCELLED`; from its commit, the shared on-sale condition (`onSaleSql`) refuses every new hold. A job then cancels the flight's live bookings, each in a short transaction of its own, reusing the customer's cancel (Day 50). Its price is an in-between state: a `CONFIRMED` booking can sit on a `CANCELLED` flight until the job reaches it.

A third way to drive the cascade, a `flight-cancelled` event through the outbox with a consumer, was also considered.

## Decision

**Option B** (domain-model Decision 18).

1. `POST /api/flights/:id/cancel` changes only the flight row: a compare-and-set of the stored status (Day 46) and an audit entry. It waits for no seat. An already cancelled flight answers `200` and writes nothing; the response carries `remainingBookings`, derived from the bookings, so progress needs no stored column.
2. **The cascade is state-driven.** "A live booking of a `CANCELLED` flight" is the work to do, read from the database on each run. The job claims one booking with `FOR UPDATE SKIP LOCKED` and runs the cancel core in its own transaction. It remembers nothing, so a run after a crash continues where the data says; two instances skip each other.
3. **One cancel core, with the reason as data.** The owner's cancel and the cascade run the same code; the reason (`CUSTOMER` / `AIRLINE`) is a parameter that decides the 24 h window (BR-BOOK-06 applies to `CUSTOMER` only) and is stored on the booking. An `AIRLINE` cancel requires the flight to be `CANCELLED`; it is not a generic `force` flag.
4. **No gateway call in the cascade** (ADR-009): paid bookings get `REFUND_PENDING`, and the reconciliation job (ADR-010) refunds.
5. **A payment loses to a cancelled flight.** Payment phase 3 confirms only if the flight is not `CANCELLED`, under a share lock on the flight row, so no booking is confirmed after its flight was cancelled; the existing refund branch takes the charge back.
6. **No event drives the cascade.** Consumers do not deduplicate by `eventId` yet, and a consumer failing halfway would rely on redelivery; the state-driven job recovers by running again.

## Consequences

**Positive**

- The admin's request locks one row for a few milliseconds. A cascade transaction locks one booking and its seats.
- The Day 47 deadlock cannot happen: the cancel locks the flight and nothing after it, so a hold can wait for it but never the other way round.
- Crash recovery and multiple instances need no extra machinery: the same claim that drives a normal run drives the rest after a failure.
- The reason survives in data, rules, events and reports.

**Measured (Day 52, `booking_test`, 100 paid bookings on a 120-seat flight)**

| | Option B | Option A (test-only) |
|---|---|---|
| Transaction holding the flight row | 3–8 ms | 536–601 ms |
| Each cascade transaction | median 5–9 ms | (one transaction) |
| A hold on the same flight, during the cancellation | refused in 19–55 ms | refused after 535–600 ms |
| Forced: option's locks against a chosen-seat hold | 0 deadlocks (3 rounds) | `40P01` in 3 of 3 rounds |

B does not finish sooner (both ~0.6–1.2 s in all); it makes no one wait for all of it.

**Trade-offs / costs**

- An in-between state of up to one job interval (~30 s): the flight is `CANCELLED` while some bookings are still live. Every read that matters checks the flight (holds, search, payment phase 3), and the global invariants allow it only until the cascade has run.
- Payment phase 1 does not check the flight, so a payment started in that gap is charged and then refunded.
- A cancel waits until no hold holds the flight's share lock, and holds arriving meanwhile get the share lock ahead of it (observed in Day 52 race test "A (queue)"): bounded by the length of a hold, not by a timeout.
- The job's claim reads the bookings of every cancelled flight on each run; cancelled flights accumulate.

**Why the reference repository's shape is not needed yet**

Across services (phase F) this becomes a saga: the Flight service owns the cancellation and the Booking service reacts to an event. Inside one service and one database, a job reading state does the same with no messaging, no dedupe store and no compensation, so the event-driven form waits until the services are split.

# Domain model and aggregates

## The problem it solves

Until Day 42 the "model" was just whatever the tables happened to be: a `flights` row with an `available_seats` counter and a `bookings` row with a `passenger_name` string. That works while every rule fits in one row. Phase D adds rules that span many rows, such as "a family of four holds four seats or none" and "a seat is sold at most once". Designing those table by table produces two kinds of bug:

- **Rules with no owner.** Every use case re-checks the rule slightly differently, or one forgets to.
- **Transactions that are too big or too small.** Too big: lock half the database "to be safe". Too small: two writes that must agree end up in separate transactions and drift apart.

A domain model decides, on paper and before code, **which data must agree with which, immediately**. Everything else follows from that.

## How it works

### 1. Ubiquitous language: one concept, one name

Every business concept gets exactly one name, used the same way in docs, code, API and tests. The glossary is in `docs/product/scope.md`.

Collisions are only visible once you write the definitions down:

| Looks like one thing | Is actually two | Why it matters |
|---|---|---|
| "seat" | **Seat**: `12A` in an aircraft's layout. **FlightSeat**: `12A` on flight `VN123` on 10 Nov. | One aircraft flies many flights. Availability can only live on FlightSeat; a Seat is never "sold". |
| "user" / "passenger" | **Account**: who logs in and pays. **Passenger**: who sits in the seat, possibly with no account. | One account books for a family. Merging them makes multi-passenger booking impossible to model. |
| "booking id" | **Booking id** (UUID, technical identity). **BookingReference** (`K7Q4PZ`, for humans). | Different jobs: one is stable and opaque, the other is short and read aloud. |

Rule of thumb: if two people would argue about what a word means, it is two concepts.

### 2. Entity vs value object

- **Entity**: has an identity that stays the same while its data changes. A Booking is still *that* booking after it moves from `HELD` to `CONFIRMED`.
- **Value object**: no identity, only a value. Two `Money { amountMinor: 1500000, currency: "VND" }` are interchangeable. You replace a value object; you never edit it in place.

Value objects carry rules with them. `Money` as an integer in minor units plus a currency code is the rule "never use floats for money" (`0.1 + 0.2 === 0.30000000000000004`), made impossible to forget.

### 3. Aggregate = consistency boundary

An **aggregate** is a cluster of data with one root that must be consistent **together, immediately**, in one transaction. Its job is to protect one or more **invariants**: rules that must never be false, not even for a millisecond.

- A rule **inside** one aggregate is enforced immediately, in one transaction.
- A rule **across** aggregates is allowed to be true **eventually**, via events.

How to find aggregates: don't start from the entities. Start from the invariants and ask "which data does this rule need to see at the same instant?"

| Invariant | Data it needs at once | So it lives in |
|---|---|---|
| A FlightSeat is held/booked by at most one active booking | That FlightSeat's status | **Flight** (seat inventory) |
| Holding 4 seats is all-or-nothing | Those 4 FlightSeats | **Flight** (same inventory) |
| A booking has 1–9 passengers, each on a distinct seat | The booking and its passengers | **Booking** |
| One Idempotency-Key, one payment | The payment record | **Payment** |

The interesting decision is the first row. Seat status could have gone into Booking ("a booking holds its seats"), but the rule is about two *different* bookings competing for one seat, and a single booking cannot see its competitor. The thing that sees every competitor is the flight's inventory, so that is where the rule lives (`docs/product/domain-model.md`, Decision 1).

### 4. How an aggregate rule is enforced in this codebase

There is no framework magic: an invariant is enforced with tools the project already has.

- **Single-row rule.** A conditional `UPDATE … WHERE <guard>` (ADR-004). The guard *is* the invariant. Today's `reserveSeat` in `api/src/bookings/postgres/postgres-booking-repository.ts` does exactly this for the seat counter (`available_seats > 0`); FlightSeat will do it per seat (`status = 'AVAILABLE'`).
- **Multi-row rule** (all-or-nothing). Several conditional updates inside one `transactionRunner.run(...)` (`api/src/transactions/postgres-transaction-runner.ts`). The first update that affects 0 rows makes the use case stop and return an outcome; throwing rolls the rest back. Per the ADR-004 addendum, no further query runs in that transaction after the miss.
- **Lifecycle rule.** Every status change is a conditional update `WHERE status = '<expected from>'`. Two racing transitions (payment vs. expiry on the same `HELD` booking) therefore cannot both win, because Postgres re-checks the guard on the locked row.

### 5. Lifecycles as transition tables

For anything with a status, write a table: **from → to, triggered by, condition, side effects**. Then list the terminal states and the forbidden transitions. The forbidden list catches the expensive bugs. For example, `EXPIRED → CONFIRMED` (a late payment) must be impossible, because the seats may already be resold.

The tables for Flight, FlightSeat, Booking and Payment are in `docs/product/domain-model.md`.

### 6. Coded business rules

Each rule gets an ID (`BR-SEAT-01`) and one sentence. Tests name the rule they prove, so "where is this rule tested?" is a `grep`, and an ADR can cite a rule exactly.

## Trade-offs / when NOT to use

- **CRUD with no invariants doesn't need aggregates.** Registering an airport (unique code, valid format) is a table plus a unique constraint. Calling it an "aggregate" changes nothing.
- **Bigger is not safer.** "Put everything in one aggregate so one transaction covers it" means every write locks everything: two customers booking different flights would contend for no reason. Make aggregates as small as the invariant allows.
- **A cross-aggregate transaction is a temporary convenience.** Today, holding seats (Flight) and creating the booking (Booking) share one transaction because both live in one database. In phase F they won't, and that workflow becomes a saga. Write that down when you rely on it, so nobody mistakes it for a permanent guarantee.
- **Don't model from the database schema.** Tables follow the model, not the other way round. Starting from tables gives you "CRUD for every table" and rules scattered across use cases.

## Gotchas

- **A stored counter next to the rows it counts is a second source of truth.** Once FlightSeat rows exist, `flights.available_seats` can drift from them. Derive it, don't store it.
- **Prices must be snapshotted.** If a booking references the flight's *current* fare, an admin's later price edit silently changes what the customer owes. Copy the price at hold time.
- **`403` vs `404` is a modelling decision, not just HTTP.** "This booking exists but isn't yours" (`403`) leaks existence. The domain rule BR-AUTH-02 says another account's booking is indistinguishable from a missing one, so the answer is `404`.
- **The boundary should survive the service split.** Ask "in phase F, which service runs this, and does it still fit in one database?" If an invariant would need two databases in one transaction, the boundary is wrong. A *workflow* spanning services is fine; an *invariant* spanning services is not.

## Related

- `docs/product/scope.md`: glossary, user stories, Won't
- `docs/product/domain-model.md`: aggregates, lifecycles, BR-* catalogue, phase-D order
- `docs/adr/004-optimistic-concurrency-control.md`: how single-row invariants are enforced
- `docs/adr/007-domain-before-advanced-patterns.md`: why the domain comes before CQRS
- `.cursor/progress/DAY-43.md`
- `docs/learnings/outbox-and-relay.md`: how cross-aggregate and cross-service consistency becomes eventual

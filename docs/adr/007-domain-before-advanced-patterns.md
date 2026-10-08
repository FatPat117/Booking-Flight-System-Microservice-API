# ADR-007: Complete the Domain Before Introducing Advanced Patterns

## Status

Accepted (Day 42B)

## Context

After Day 42, the plan was to start "Group C" on Day 43 with an assessment of CQRS and Mediator, followed by the service split. Three things made that order hold up poorly.

- **Too little evidence for CQRS.** `api` has about five use cases:
  - create flight
  - list flights / get flight
  - create booking
  - cancel booking

  Reads and writes share one model with no skew. An assessment now could only conclude "not needed" or adopt the pattern for its own sake. Neither teaches anything, and the second contradicts this project's rule that patterns need evidence.
- **The product is not yet a booking system.** There are no airports, aircraft, schedules, seat maps, passengers, payment or cancellation policy. For the portfolio goal, the domain is the weakest part, not the architecture.
- **Splitting an unstable domain is risky.** Service boundaries drawn around five use cases would be guesses. When boundaries are wrong, services end up calling each other synchronously for every request, which gives a distributed monolith that pays the cost of distribution without the independence.

## Decision

Complete the domain inside the `api` monolith first (phase D), then introduce CQRS/Mediator (E), the service split (F) and observability (G). The CQRS/Mediator assessment moves to the start of phase E. The phase contents are in [`docs/roadmap.md`](../roadmap.md).

## Consequences

**Positive**

- When CQRS and Mediator are assessed, they are judged against a real domain with many use cases and genuine read/write differences, such as flight search versus seat holds.
- Service boundaries in F can follow the dependencies phase D actually exercised, not ones guessed now.
- Domain rules are built and tested once, in one process, where refactoring is cheap.

**Trade-offs / costs**

- **More to migrate later.** Every use case written in D is one more to move behind a mediator in E. That is an estimated 20+ instead of 5.
- **A bigger split in F.** By then `api` holds much more code and data. Separating Flight and Booking will touch more tables, more transactions and more tests than it would today, and transactions that are local now may need a saga.
- **The CV shows a monolith for a long time.** Until phase F (likely past Day 65), the project demonstrates one large service plus Identity and a notifier, not a full microservice system.
- **Monolith shortcuts are a risk.** Code inside one process can couple features in ways that are hard to undo, such as a booking use case reading flight tables directly. Keeping features behind their ports in D is what keeps F affordable, and it depends on review discipline, not on tooling.

# ADR-008: Derive Time-Based Flight Statuses Instead of Storing Them

## Status

Accepted (Day 46)

## Context

The Flight lifecycle (Day 43, `docs/product/domain-model.md`) has five statuses. Two kinds of event move a flight between them:

- **A person decides.** An admin opens a flight for sale or cancels it. Nothing but a stored value can remember that.
- **The clock moves.** Sales close one hour before departure (`OPEN → CLOSED`, BR-FLT-06), and the flight departs at departure time (`CLOSED → DEPARTED`). The Day 43 table assigned both to a "system job" (US-OPS-02).

A job that writes time-based statuses brings three problems:

- **Latency.** A job running every minute leaves the flight `OPEN` for up to a minute after sales should have closed.
- **Operations.** It needs a plan for a late or failed run. The project has had in-process jobs only since Day 17, and they run twice if two instances run.
- **A race with seat holds.** A user holding a seat at 59 minutes before departure competes with the job closing the flight. Who wins depends on scheduling, not on the rule.

## Decision

Store only the statuses people set: `SCHEDULED`, `OPEN` and `CANCELLED`. Compute `CLOSED` and `DEPARTED` from the stored status, the departure time and the current time, in one pure function (`effectiveFlightStatus`). Every rule, read and transition uses the effective status. The seat-hold `UPDATE` repeats the condition in its `WHERE` clause (`status = 'OPEN' AND departure_at - interval '1 hour' > now`), so BR-FLT-06 is enforced in the same statement as the seat count.

## Consequences

**Positive**

- The status is right at every instant. There is no job, no job latency and no job-versus-booking race.
- BR-FLT-06 joins the existing optimistic-concurrency check (ADR-004): one conditional `UPDATE` decides seat count and sales window together.
- BR-PAY-06 (pay a valid hold after sales close) needs nothing extra. Payment checks the hold's expiry, not a stored `CLOSED`.
- Phase D step 9 shrinks to the cancellation cascade. US-OPS-02 is satisfied by reads.

**Trade-offs / costs**

- **The database row is not the whole truth.** A query on `flights.status` alone says `OPEN` for a flight that has departed. Any SQL report must apply the same rule, or call the same function.
- **The rule exists in two languages.** It lives in TypeScript (`effectiveFlightStatus`) and in SQL (the hold's `WHERE` clause). The two can drift. A contract test asserts that both agree at the one-hour boundary.
- **Clock source matters.** The application passes its own `now` into the SQL condition, so reads and holds use one clock. A skewed application clock shifts the sales window for every instance at once.
- **No event when sales close.** No row changes, so the outbox has nothing to publish. If a consumer ever needs `flight-closed`, a scheduled publisher would have to be added for that purpose alone. The status would still not be stored.

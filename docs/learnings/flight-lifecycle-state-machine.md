# Flight lifecycle: a state machine as data

## The problem it solves

A flight has statuses (`SCHEDULED`, `OPEN`, `CLOSED`, `DEPARTED`, `CANCELLED`) and only some changes make sense: you cannot reopen a departed flight, or open one that leaves in 30 minutes. If each use case writes its own `if (status === "SCHEDULED" && ...)`, the rules get copied, drift apart, and nobody can see the whole picture.

## How it works

All in `api/src/flights/flight-lifecycle.ts`, as data plus pure functions.

### 1. Stored vs effective status (ADR-008)

| Kind | Statuses | Where it comes from |
|---|---|---|
| Stored | `SCHEDULED`, `OPEN`, `CANCELLED` | a person's action, saved in `flights.status` |
| Derived | `CLOSED`, `DEPARTED` | the clock, never saved |

`effectiveFlightStatus(stored, departureAt, now)`:
- `CANCELLED` stays cancelled.
- `now >= departure` → `DEPARTED`.
- stored `OPEN` and `now >= departure − 1h` → `CLOSED` (BR-FLT-06).
- otherwise the stored value.

Why not store them? Nothing would be running at the exact moment a flight leaves to update the row, so the stored value would be wrong until a job fixes it. Deriving it from the clock is always right and needs no job. Every rule and read uses the effective status.

### 2. The transition table (`FLIGHT_TRANSITIONS`)

`FLIGHT_TRANSITIONS[from][to] = guard`

| From \ To | OPEN | CANCELLED |
|---|---|---|
| `SCHEDULED` | only if departure is more than 1 h away | always |
| `OPEN` | no | always |
| `CLOSED` | no | always |
| `DEPARTED` | no | no |
| `CANCELLED` | no | no |

A pair that is **missing is forbidden**, so adding a status never opens a door by accident, and the terminal statuses are just empty rows. Targets are only stored statuses: nobody can "close" or "depart" a flight by hand.

### 3. Guards: `undefined` means "allowed"

```ts
type TransitionGuard = (context) => TransitionRejection | undefined;
const unconditional: TransitionGuard = () => undefined;
```

A guard returns a **reason to reject**, or `undefined` when nothing blocks the move. A `boolean` could not say *why*; the reason (`DEPARTURE_TOO_SOON` vs `NOT_ALLOWED`) lets the HTTP layer answer precisely.

`transitionFlight(from, to, context)` looks up the guard; no guard → `{ ok: false, reason: "NOT_ALLOWED" }`; otherwise runs it and returns `{ ok: true }` or `{ ok: false, reason }`.

### 4. How a use case uses it (`open-flight.ts`)

1. Load the flight, compute `effectiveFlightStatus(...)`.
2. Ask `transitionFlight(current, "OPEN", { departureAt, now })`.
3. Not ok → return `invalid-status` with the reason.
4. Ok → inside a transaction, `flightRepository.changeStatus(id, flight.status, "OPEN")`, then write the audit row.

Step 4 passes the status that was read as the *expected* value: the update only succeeds if the row still has it. If someone cancelled the flight in between, the repository returns `status-changed` instead of overwriting it (optimistic concurrency, the same idea as for seats).

### Example

```ts
transitionFlight("SCHEDULED", "OPEN", { departureAt, now })
// departs in 3 h  → { ok: true }
// departs in 30 m → { ok: false, reason: "DEPARTURE_TOO_SOON" }
transitionFlight("DEPARTED", "OPEN", ...)  // { ok: false, reason: "NOT_ALLOWED" }
transitionFlight("OPEN", "CLOSED", ...)    // { ok: false, reason: "NOT_ALLOWED" }
```

## Trade-offs / when NOT to use

- A table is overkill for 2 statuses and 1 rule; an `if` is clearer. It pays off once there are several statuses, conditions, and several places that need the same answer.
- Derived statuses mean the rule exists twice: in TypeScript (`isBookable`) and in SQL for the seat-hold `UPDATE` (`status = 'OPEN' AND departure_at - 1 hour > now`). Comments and the contract test keep them in step; they can still drift.
- A hand-rolled table has no tooling (no diagrams, no visualizer). A library such as XState only makes sense when transitions carry side effects, nested states or timers.

## Gotchas

- `undefined` from a guard means **allowed**, which reads backwards from "empty = failure". The type comment says so.
- The table is keyed by the **effective** status, not the stored one. Passing the stored value would let a `CLOSED` flight look `OPEN`.
- `→ CANCELLED` is legal in the table but no route offers it yet (needs the booking cascade).
- Take `now` as a parameter (injected clock), otherwise tests cannot be deterministic.

## Interview Q&A

**How did you model the flight lifecycle?**
As a transition table keyed by `(from, to)` with an optional guard per cell. Anything not listed is forbidden, so terminal states are empty rows. Use cases ask one pure function instead of re-implementing the rules.

**Why are `CLOSED` and `DEPARTED` not stored?**
They are functions of time. Storing them needs a job to flip them at the right moment and is wrong in between. Computing from the clock is always correct.

**Why guards return a reason instead of a boolean?**
The caller needs to know why it was rejected to return a precise error, without parsing messages.

**How do you avoid two requests changing the same flight at once?**
`changeStatus(id, expectedStatus, newStatus)` only updates if the row still has the expected status; otherwise the use case reports `status-changed`.

**How do you test it?**
It is pure: pass a fixed `now` and assert the result for each pair. No database, no mocks.

## Related

- `docs/adr/008-time-derived-flight-status.md`
- `docs/product/domain-model.md`: Decision 9, "Lifecycles → Flight", BR-FLT-06
- Code: `api/src/flights/flight-lifecycle.ts`, `api/src/flights/open-flight.ts`, `api/src/flights/flight-view.ts`
- `docs/learnings/domain-model-and-aggregates.md`

# Flight cancellation: a short status change and a state-driven cascade

## The problem it solves

Cancelling a flight (US-OPS-01) must end every live booking on it: free its seats, refund the paid
ones, tell each customer. A full flight is a hundred or more bookings, each with seats, maybe a
payment, an audit entry and an event. The question is not *what* to write but *in how many
transactions*, and what that does to everyone else using the flight at the same moment.

## The two shapes

| | A — one transaction | B — status change, then a cascade |
|---|---|---|
| Atomic | Yes, no in-between state | No: `CANCELLED` flight with live bookings for up to one job interval |
| Locks held | The flight row, every seat and booking, for the whole run | The flight row for milliseconds; then one booking and its seats per transaction |
| Lock order | Flight, then seats: the reverse of the hold | The cancel waits for no seat |
| Crash midway | Everything rolls back; the admin tries again | The next run continues |

Day 52 chose B (Decision 18, ADR-011).

## How it works

1. `POST /api/flights/:id/cancel` runs a compare-and-set of the flight's stored status to
   `CANCELLED` and one audit entry, nothing else. From its commit, the shared on-sale condition
   (`onSaleSql`) refuses every hold, and search drops the flight.
2. `flight-cancellation-cascade-job` (every 30 s) loops: in a transaction, claim one live booking of
   any `CANCELLED` flight with `FOR UPDATE SKIP LOCKED`, run the cancel core with reason `AIRLINE`,
   commit. Stop when the claim finds nothing.
3. The cancel core is the customer's cancel of Day 50: lock the booking in a statement of its own,
   release its seats in `(row, letter)` order, move a `SUCCEEDED` payment to `REFUND_PENDING`, write
   the audit entry and the `booking-cancelled` event. The reason is its parameter:
   - `CUSTOMER` keeps the 24 h window (BR-BOOK-06);
   - `AIRLINE` drops it, but requires the flight to be `CANCELLED`.
4. The reconciliation job refunds. Nothing in the cascade calls the gateway.
5. Payment phase 3 confirms a booking only if its flight is not `CANCELLED`, under a share lock on
   the flight row, so a payment that was at the gateway when the flight was cancelled is refunded.

### State-driven, not event-driven

The job keeps no memory and receives no message. "A `CANCELLED` flight with a live booking" *is* the
work left, read from the database each run. That is why a crash costs nothing, why two instances do
not collide (`SKIP LOCKED`), and why no dedupe store is needed. An event-driven cascade
(`flight-cancelled` → consumer) would need each event processed effectively once, and the consumers
here do not deduplicate by `eventId` yet. Across services, in phase F, this becomes a saga: the same
shape with messages between owners.

### The reason is data, not a flag

A `force: true` that skips the window would say nothing about *why*, and anyone could pass it. The
reason is stored on the booking (`cancellation_reason`, with a CHECK that it is set exactly when the
status is `CANCELLED`), carried by the audit entry and the event, and it narrows what it allows: an
`AIRLINE` cancel of a booking whose flight is not cancelled throws.

## The deadlock experiment

The Day 47 review predicted a deadlock: the hold locks seats and then shares the flight, so anything
that locks the flight and then seats closes a cycle. Day 52 tested both halves with gates:

- **Option A, test-only, forced:** a transaction updates the flight; a chosen-seat hold locks 12A and
  waits for the flight; the transaction then locks every seat of the flight. Result: `40P01` in
  3 rounds out of 3.
- **The real cancel, the same interleaving:** the hold waits for the flight row, the cancel commits,
  the hold re-reads the row and answers `SALES_CLOSED`. 0 deadlocks.

An unforced run (20 holds and a cancel at once, 5 rounds, 10 runs) never deadlocked, but it never
refused a hold either. Forcing it showed why: while the cancel's `UPDATE` waits behind one hold's
share lock, a hold arriving later is granted the share lock at once, because it is compatible with
the lock already held. The cancel runs only when no hold holds the flight. That is how row-level
share locks behave in Postgres, and it is bounded here because a hold takes milliseconds.

## How a confirm loses to the cancel

READ COMMITTED gives each statement a snapshot from its start. A confirm that started while the
cancel's `UPDATE` was uncommitted sees the flight `OPEN` in its snapshot. Without a lock it would not
wait, confirm, and commit. With `FOR SHARE` on the flight row it waits for the cancel (`FOR SHARE`
conflicts with the `FOR NO KEY UPDATE` an `UPDATE` of a non-key column takes; `FOR KEY SHARE` would
not). After the cancel commits, Postgres re-reads the newest version of that row and re-checks
`status <> 'CANCELLED'`. It fails, the confirm matches nothing, and the payment is refunded. Race
test B3 forces this; B' shows the old statement confirming on a cancelled flight.

## Measured (`booking_test`, 100 paid bookings on a 120-seat flight)

| | B | A (test-only) |
|---|---|---|
| Transaction holding the flight row | 3–8 ms | 536–601 ms |
| Each cascade transaction | median 5–9 ms | — |
| A hold on the same flight, meanwhile | refused in 19–55 ms | refused after 535–600 ms |

B does not finish sooner; it makes nobody wait for all of it. Measure lock duration per transaction,
not only the total.

## Interview questions

- *Why not cancel all bookings in the admin's request?* Lock duration (every hold on the flight waits
  for all of it), lock order (flight then seats is the reverse of the hold: measured deadlock), and
  recovery (a crash rolls back everything). The price of the alternative is an in-between state,
  which is written down as an invariant and checked.
- *What makes the job safe to run twice or after a crash?* It is driven by state, claims with
  `SKIP LOCKED`, and each booking is one transaction whose conditional cancel matches nothing the
  second time.
- *How do you stop a payment confirming a booking on a cancelled flight?* Check the flight inside the
  confirming statement under a share lock, so a concurrent cancel is waited for and re-checked.

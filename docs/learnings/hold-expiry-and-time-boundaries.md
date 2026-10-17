# Hold expiry and time boundaries

## The problem it solves

A booking holds seats for 15 minutes (BR-BOOK-04). After that the seats must become sellable
again, and the booking must stop behaving like a valid hold. "After that" is harder than it
sounds: the deadline passes at an instant, but nothing in a database *happens* at that instant.
Something has to notice, and until it does, three readers ask "is this hold over?":

1. **Inventory** — can someone else take the seat?
2. **Display** — what does the owner see?
3. **Decisions** — may the owner still cancel? (step 6: may they still pay?)

## How it works

Each reader gets its own mechanism (Decision 12):

| Reader | Mechanism | Where |
|---|---|---|
| Inventory | a job changes the rows | `ExpireHolds` + `booking-hold-expiry-job`, every 60 s |
| Display | derive on read | `withEffectiveStatus` in `booking-lifecycle.ts` |
| Decisions | deadline inside the conditional `UPDATE` | `cancel()`: `hold_expires_at > $now` |

**Why not derive the inventory too?** Then every seat count and every hold must join `bookings` to
ask whether a `HELD` seat's owner has lapsed, the partial-index count of Day 47 is lost, and a new
hold has to *take over* a seat still marked `HELD` — two writers on one row. Deriving is perfect for
a value nobody writes (a flight's `CLOSED`, Day 46); it is wrong for a row others claim.

**Why not trust the job for decisions?** The job runs every 60 s. A cancel 10 s after the deadline
would be a cancellation or an expiry depending on the timer. With the deadline in the `WHERE`,
the result depends only on the clock.

### The boundary (BR-BOOK-10)

```text
holdExpiresAt <= now   → expired   (the sweep)
holdExpiresAt >  now   → valid     (cancel, payment)
```

Complementary: no instant is on both sides or on neither. Write it once in TypeScript
(`isHoldLapsed`), once per SQL statement, and pin both with a test **at the exact instant** — the
repository contract runs "cancel at the deadline is `expired`" and "the sweep at that same instant
takes it". A test 1 minute away from the deadline cannot tell `<` from `<=`.

Read `now` **once** per operation. The sweep reads it once per *run* and uses it for every batch;
otherwise a hold lapsing mid-run joins a later batch and the run's result depends on its own speed.
The unit test catches that with a clock that moves right after it is read.

### The sweep

```sql
WITH due AS (
  SELECT id FROM bookings
  WHERE status = 'HELD' AND hold_expires_at <= $1
  ORDER BY hold_expires_at, id LIMIT $2
  FOR UPDATE SKIP LOCKED                     -- never wait for a cancel or another sweeper
), expired AS (UPDATE bookings … FROM due …),
   locked AS (SELECT … FROM flight_seats … ORDER BY flight_id, row, letter FOR UPDATE),
   released AS (UPDATE flight_seats … FROM locked …)
SELECT … FROM expired LEFT JOIN locked …     -- seats from the CTE: the table shows the old snapshot
```

- **Batches, one transaction each.** Locks stay short and a failure loses one batch, not the run.
  A run stops when a batch comes back short, or after 20 (a backlog warning).
- **Partial index `(hold_expires_at, id) WHERE status = 'HELD'`.** Holds are a small live slice of
  a table that only grows. With `id` in the key the plan reads in order and stops at `LIMIT`; with
  `hold_expires_at` alone it adds an Incremental Sort. Measured on 100 000 bookings: 104 buffers vs
  2 990 without the index.
- **`SKIP LOCKED` is about waiting, not correctness.** Without it, a second sweeper waits, re-checks
  `status = 'HELD'` on the committed row and drops it — still correct, just serialized (race test B:
  ~910 ms vs ~250 ms, zero overlapping batches).

### Releasing seats in the global lock order

A chosen-seat hold locks seats in `(row, letter)` order whatever their status. A release that
locks the same seats in another order can meet it in a cycle: hold has 12A and wants 12B, release
has 12B and wants 12A → `40P01`. So release locks first, in order, then updates exactly what it
locked. Cancel and expiry share the CTE (`releaseSeatsOf`).

**Proving it needed a gate.** A single fast statement never shows the race: the release locks both
seats before the hold arrives. Race test E holds 12A in a third transaction, lets the hold queue
on it, then starts the release. Reversed order: deadlock 5/5. Real order: the release queues behind
the hold holding nothing, 0 deadlocks.

## Gotchas met

- **`RETURNING` returns the new row.** A control query joined on `seat.booking_id` from an `UPDATE
  … SET booking_id = NULL … RETURNING` and got nothing back. Return the id from the CTE you joined.
- **Same deadline, different order.** Three holds made at the same instant are swept by `id`, a
  random UUID — not in the order the test created them. Assert counts, or find "the one left".
- **A mutation that breaks the SQL proves nothing.** Removing the `> $2` condition left `$2` unused,
  Postgres could not infer its type, and 14 tests failed for that reason. Keep the parameter
  referenced so the only change is the behavior.
- **Stopping the scheduler must wait.** `stop()` used to clear timers and return; `close()` then
  destroyed the `DataSource` under a running batch. `stop()` now awaits the run in progress.
- **The duration is not configuration.** A setting only tests would change is a production knob
  nobody should touch. Tests move the deadline: a fake clock, or `psql` in e2e.

## Interview questions

- *Expire on read or with a job?* Both, per reader: derive for display, job for inventory,
  deadline-in-the-`WHERE` for decisions. Explain why inventory cannot be derived cheaply.
- *Two instances run the job — what happens?* `SKIP LOCKED` splits the work; each booking is
  expired once because the second writer re-checks the status. Without `SKIP LOCKED`: still once,
  but serialized.
- *Cancel and expiry in the same millisecond?* Complementary conditions + row lock → one end.
  Which one wins with equal clocks is decided by the boundary, not by timing.
- *How do you test a deadline?* Inject the clock; test at the instant and 1 ms before; in e2e, move
  the stored deadline instead of making the duration configurable.

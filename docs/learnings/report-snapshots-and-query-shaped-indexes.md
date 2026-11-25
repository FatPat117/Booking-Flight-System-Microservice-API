# Reports: one snapshot per report, indexes shaped by the query

Day 53 added three read-only admin reports: a flight manifest, load factor over a date range, and an
audit log viewer. Building them taught three lessons.

## 1. A report built from several statements can contradict itself

The manifest is two statements:
- the flight with its seats counted per class;
- the list of `CONFIRMED` passengers.

At READ COMMITTED each **statement** takes its own snapshot. If a booking is cancelled and
committed between the two, the report shows "3 booked" above a list of 1 passenger. No row in the
database is wrong, but the report is.

Two ways out:
- **One statement.** It has one snapshot by definition. Load factor and the audit log page do this.
- **One transaction at `REPEATABLE READ`.** Every statement in it sees the snapshot taken at its
  first statement. The manifest does this, as `REPEATABLE READ READ ONLY`:
  - `READ ONLY` makes a write inside the report an error.
  - A read-only `REPEATABLE READ` transaction in Postgres never fails with a serialization error,
    so there is nothing to retry. That is the difference from a read-write transaction at the same
    level.

### How it was proved

A gate pauses the manifest between its statements. Meanwhile a booking of 2 passengers is cancelled
and committed on another connection. Then the gate opens.

| Isolation | Result |
|---|---|
| `REPEATABLE READ` (the adapter) | 3 booked, 3 passengers: the world before the cancel, consistent |
| `READ COMMITTED` (test-only control) | 3 booked above 1 passenger |

Changing the adapter to `READ COMMITTED` makes the test fail (a mutation check). The race is real,
and the test can see it.

### The price of a long snapshot

While a `REPEATABLE READ` transaction is open, Postgres cannot vacuum row versions its snapshot may
still need. A report that runs for minutes (say, exporting a year of audit) holds back cleanup for
the whole database. So every report has a ceiling, not only for latency:
- the manifest covers one flight (at most 900 seats);
- load factor covers 31 days and 50 flights a page;
- the audit log covers 31 days or one target, and 100 entries a page.

## 2. Indexes come with the query, shaped by it

`audit_logs` had no index from Day 38 until Day 53, on purpose: no query read it, and an index on a
table that only grows is a cost on every write.

The audit log viewer is the first query that reads the table. Its required filters decide the
indexes:

| Query shape | Index |
|---|---|
| `target_type = ? AND target_id = ? ORDER BY occurred_at DESC, id DESC` | `(target_type, target_id, occurred_at DESC, id DESC)` |
| `occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC, id DESC` | `(occurred_at DESC, id DESC)` |

Both also serve the keyset continuation `(occurred_at, id) < (?, ?)`.

The API refuses a query that neither index can serve: no target and no range is
`422 FILTER_REQUIRED`. Actor and action only narrow what an index finds, so they got no index.

Measured on 300 000 entries (`EXPLAIN (ANALYZE, BUFFERS)`, before → after):

| Query | Before | After |
|---|---|---|
| One booking's entries | Seq Scan, 48.8 ms, 6 538 buffers | 0.08 ms, 19 buffers |
| One day | 30.5 ms | 0.1 ms, 36 buffers |
| 31 days filtered to one account | 26.9 ms | 17–38 ms, 6 701 buffers (no actor index) |

The last row is the honest cost of "actor has no index": the query reads all 51 000 entries of the
range to find about 100. When a real query needs "what did admin X do", it gets its own index.

The indexes were built `CONCURRENTLY` (a migration with `transaction = false`), so building them
never blocked the writes every request makes to `audit_logs`. If that fails halfway it leaves an
`INVALID` index of the same name: drop it and run the migration again.

## 3. An index does not fix counting

Load factor over 31 days picks its 51 flights through `idx_flights_departure` in 5 buffers. It
then counts about 9 400 seats, which sit on **8 963 heap blocks**. The cost is the seats, not
finding the flights, so an index on flights changes nothing.

The fixes would be:
- a covering index on `flight_seats` (the counts read from the index alone);
- a stored per-class counter. That counter is a small read model: every hold, confirm, cancel,
  expiry and seat change would have to keep it correct.

Neither is needed at 50 flights a page (8 ms). Both go in the evidence for the phase E discussion.

## Personal data in an admin API

The manifest returns the minimum: reference, name, seat and fare class. Being admin-only does not
make the rest necessary. Reading it is audited (`FLIGHT_MANIFEST_VIEWED`, with a count and never a
name) in a transaction of its own. If that write fails, the manifest is not sent. The request log
never carries bodies; a test and the compose stack's logs confirmed no passenger name reached a
log line.

## Interview questions

- *Two queries in one report disagree under load. Why, and what are the fixes?* READ COMMITTED is
  a snapshot per statement. Fix it with one statement, or with `REPEATABLE READ READ ONLY`, which
  never fails with a serialization error and so needs no retry. Bound the report, because a long
  snapshot holds back vacuum.
- *When do you add an index to an append-only table?* When a query appears. Take its shape from
  that query (equality columns first, then the sort with its tie-breaker), and refuse queries no
  index serves. Build it concurrently.
- *Your cursor is a hash, not an HMAC. Is that safe for private data?* Here it is. The cursor
  carries only a position, and the filter always comes from the request. The caller can already
  run any filter, so a forged cursor only moves within a query they may run. Any restriction for a
  narrower role belongs in the `WHERE`, never in the cursor.

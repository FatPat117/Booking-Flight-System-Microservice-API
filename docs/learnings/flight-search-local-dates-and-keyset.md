# Flight search: local dates, sargable windows, keyset pages, differential tests

## The problem it solves

Until Day 51 a customer could list every flight (`GET /api/flights`, the admin list with `OFFSET`
pages) but not ask the question a customer asks: "SGN → HAN on 1 December, 2 of us". Answering it
well raised four problems at once:

1. **Which day is "1 December"?** A traveller means 1 December where they board. In Vietnam
   (UTC+7) 06:00 on the 1st is 23:00 UTC on 30 November. A filter on the UTC date loses it, and
   shows a 23:30 local flight under the next day.
2. **How to filter by a local date without losing the index?** The obvious SQL —
   `(departure_at AT TIME ZONE tz)::date = $1` — is correct and computes an expression for every row.
3. **What does "room for 2" mean?** 1 business + 1 economy seat is not a booking anyone can make.
4. **How to page a result that changes while it is read?** A flight on page 1 can sell out before
   page 2 is asked for.

## How it works

### Local dates → one UTC interval, from the parameters (sargable)

`api/src/flights/postgres/flight-search-sql.ts`, CTE `bounds`:

```sql
($3::date::timestamp AT TIME ZONE origin.time_zone)       AS starts_at  -- local midnight as an instant
(($4::date + 1)::timestamp AT TIME ZONE origin.time_zone) AS ends_at
…
WHERE departure_at >= starts_at AND departure_at < ends_at              -- the column is bare
```

- `timestamp AT TIME ZONE zone` reads a wall-clock time *in that zone* and gives the instant. Local
  midnight of the 1st in `Asia/Ho_Chi_Minh` is `2026-11-30 17:00Z`.
- **Transform the parameter, not the column.** The condition compares `departure_at` with two
  values, so `idx_flights_route_departure (origin_airport_id, destination_airport_id,
  departure_at)` can range-scan it. Two equalities first, the range last.
- **A local day is not 24 hours.** In `Europe/London` 28 March 2027 is 23 hours and 31 October 2027
  is 25. Computing `end = start + 24 h` is wrong twice a year; computing the end as "local
  midnight of the next date" in the zone is right every day.
- One search has one origin, so one zone; there is no per-row zone to worry about.

### Room for N means N in one fare class — and the hold must agree

A flight matches when some class has ≥ N `AVAILABLE` seats. `lowestFare` is the cheapest class *with
room*, not the cheapest class. The auto hold had to change to match (BR-BOOK-09): it took the lowest
seats of any class (business rows first) and could mix classes. Now the body names `fareClass` and
the hold takes seats of that class only. A search that says "economy has room for 2" leads to a hold
that can take 2 economy seats. "On sale" is one SQL fragment (`onSaleSql`) shared by the holds and
the search, so the two can never disagree about it.

A result is still a **snapshot, not a promise**: the hold decides under its locks.

### Keyset pages

`OFFSET 20` means "skip 20 rows of *today's* result". If a row before position 20 leaves the result
between two requests, every later row moves up one place and one is never shown. Measured in
`flight-search-pagination.integration.test.ts`: after page 1 (3 flights) one of them sells out;
`OFFSET 3` returns flights 5–7, so flight 4 is on neither page.

Keyset asks for "rows **after** the last key I saw": `WHERE (departure_at, id) > ($last_departure,
$last_id) ORDER BY departure_at, id LIMIT n + 1`. A row disappearing before that key moves nothing.

- **The key must be a total order.** Two flights at the same minute: without `id` as the last
  column, one could appear on two pages or on none.
- **The extra row** (`limit + 1`) tells whether a next page exists. No `total`: it would be a second
  scan for a number no screen uses.
- **The cursor** (`api/src/flights/search-cursor.ts`) is base64url JSON `{ v, k, s }`: version, the
  last sort key, and a SHA-256 over the key and the normalised search. A cursor from another search
  or a damaged one answers `400`. The hash is not a secret: a forged key for the same search is just
  another starting point of that search's order, over public data. A cursor carrying something the
  client must not choose (an owner id) would need an HMAC with a server key.
- **Stateless.** The server stores no cursor; the client keeps the last `nextCursor`.
- **What it costs:** no "jump to page 7", no "previous page" from the server, and the cursor is
  valid for one search only. The admin list keeps `OFFSET` (jumping and `totalItems` are useful
  there, and it has no live filter).

### Counting availability: measure before inventing a read model

`api/tests/perf/` seeds 20 400 flights and 3.9 M flight seats in `booking_test` and runs
`EXPLAIN (ANALYZE, BUFFERS)` under several index choices. What it showed:

- **Seat counting, not flight lookup, is the cost.** ~90 % of the buffers were seat rows.
- Counting **only `AVAILABLE` seats, starting from the flight's fares** (its exact classes,
  BR-FLT-09) instead of every seat with a `FILTER` cut the buffers 3.6× (6 314 → 1 765).
- The route index halved the time (10.7 → 4.8 ms). `(departure_at)` alone was as fast *on this data*
  but read every route's flights in the window and threw most away — it degrades with routes.
- A partial index on free seats per class halved it again (2.6 ms) and was **not** adopted: it sits
  on the hottest table, and its index-only scans depend on a visibility map that those writes keep
  clearing. It is the first lever if search becomes hot — before any read model.

### Differential testing

`flight-search.differential.integration.test.ts` builds 50 seeded random worlds (both London DST
changes, departures on local midnight ± 1 minute, five seat-occupancy modes, `now` at sales close),
asks the SQL and a **naive** filter written in the test, and requires identical lists, order
included. The naive side imports nothing from `src/` — not even the zone table — and finds each
flight's local date with `Intl`, one flight at a time. Two independent implementations rarely agree
on the same wrong answer.

It is only worth something if it fails: filtering by the UTC date failed on the first seed; summing
seats across classes failed too — but as a thrown error *without* the seed, so the test now wraps
every throw with `FLIGHT_SEARCH_SEED=<n>` to replay it.

## Gotchas

- `Intl.DateTimeFormat` with `hour: "2-digit"` can print `24` for midnight; use `hourCycle: "h23"`.
- A query-string parameter repeated (`?origin=A&origin=B`) arrives as an array: reject it, never
  take the first value.
- `/api/flights/search` must be registered before `/api/flights/:id`, or "search" is read as an id.
- A fixture flight with 0 seats used to mean "sold out"; with the class check it means "no such
  class". Sold out is seats that exist and are taken.

## Related

Decision 17 and BR-FLT-10/11 in `docs/product/domain-model.md`; Decision 7 (IANA zones);
ADR-008 (derived status); `.cursor/progress/DAY-51.md` ("Evidence for phase E");
`reference-data-and-seat-layouts.md` (time zones, input amplification).

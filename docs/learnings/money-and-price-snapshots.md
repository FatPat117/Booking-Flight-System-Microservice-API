# Money and price snapshots

## The problem it solves

Until Day 49A a flight had one `price_in_cents integer` and a `currency` (`VND` or `USD`), and a
booking stored no price at all. Payment (Day 49B) has to charge *an amount*, and three questions had
no answer:

1. **What is the amount made of?** One number per flight cannot price a business seat and an
   economy seat differently.
2. **Which price does the customer pay** if an admin changes the fare between the hold and the
   payment?
3. **Is the number right?** `price_in_cents` held `1500000` for a 1.5 million đồng ticket — whole
   đồng, despite the name. One reader dividing by 100 makes it 15 000 đồng.

## How it works

### `Money`: an integer in the currency's smallest unit

`api/src/money/money.ts` — `Money = { amount: number; currency: "VND" }`.

- **Never a float.** `0.1 + 0.2 !== 0.3`; money is counted in whole units of the smallest coin.
- **For VND the smallest unit is the đồng.** No ×100: `vnd(1_500_000)` is 1.5 million đồng. USD
  would be cents, which is exactly why the old column name lied for VND.
- **`bigint` in Postgres, `number` in TypeScript.** `pg` returns `bigint` as a *string* (a JS number
  cannot hold every 64-bit integer). `parseVndFromDatabase` accepts only a plain digit string whose
  value is a safe integer (≤ 2^53 − 1) and throws otherwise: `Number("9007199254740993")` is
  silently `9007199254740992`, and `Number("")` is `0`. A `CHECK (amount_vnd <= 9007199254740991)`
  refuses such a value on write, so the throw is a last line, not the expected path.
- **Adding** checks the currency and the safe range (`addMoney`); `sumMoney([])` is zero, so a
  total never needs a special case.

The alternatives: a decimal library or `bigint` in TypeScript. Both are right for amounts past
9·10^15 or for fractional units; neither is needed for a ticket price in đồng, and both spread
into every type and JSON response.

### One fare per fare class (`flight_fares`)

`(flight_id, fare_class)` primary key, `amount_vnd bigint > 0`. A row per class, not columns
(`economy_price`, `business_price`): no nullable column for economy-only aircraft, no schema change
for a third class, and the same key as `flight_seats.fare_class`, so a seat joins to its price.

**BR-FLT-09: the classes with a fare are exactly the classes with seats.** A database cannot say
"for every distinct `fare_class` in `flight_seats` of this flight there is a row in
`flight_fares`" — a `CHECK` sees one row, a foreign key points one way. So the application keeps it
(CreateFlight → `422 MISSING_FARE` / `FARE_CLASS_NOT_ON_AIRCRAFT`), the contract migration checked
existing data, and the hold throws if it ever meets a seat without a fare. Writing *who* keeps an
invariant is part of the design: "the database guarantees it" would be false here.

### The snapshot: copy the price when the seats are held

Each `booking_passengers` row stores `fare_class` and `price_vnd`. `Booking.total` is derived
(`bookingTotal`), not stored: the prices never change after the hold, so a stored total could only
disagree with them. Same idea as the seat layout copied into `flight_seats` (Day 47): keep the value
that was true at the moment of the decision.

### Reading the fare inside the hold, share-locked

```sql
WITH …, held AS (UPDATE flight_seats … RETURNING row, letter, fare_class),
     fares AS (SELECT fare_class, amount_vnd FROM flight_fares WHERE flight_id = $1 FOR SHARE)
SELECT held.row, held.letter, held.fare_class, fares.amount_vnd
FROM held LEFT JOIN fares ON fares.fare_class = held.fare_class
```

- **Same statement as the hold**: all seats of one booking are priced from one version of the
  fares. Two queries (read fares, then hold) would each see their own snapshot in READ COMMITTED.
- **`FOR SHARE`**: a fare change (`UPDATE flight_fares`) needs the row exclusively, so it waits for
  a hold in progress; a hold that meets an uncommitted change waits for it and then reads the
  committed row. Without it, a booking can commit after a fare change with the old fare (race test
  B2's control shows it).
- **The CTE must be read.** Postgres runs a plain-`SELECT` CTE only when something reads it. Declare
  `fares … FOR SHARE` and take the price from a scalar subquery instead, and the statement still
  returns the right price — with no lock. Only the race test noticed (mutation, Day 49A).

### Changing the model on existing data

Expand (`flight_fares`) → backfill (only what can be known: a `VND` flight's price as its ECONOMY
fare) → contract (refuse with a list while a class with seats has no fare; then drop the old
columns). No exchange rate in a migration: a `USD` flight is listed and a person sets its fare.
Bookings made before the change are priced at migration time, and the migration says so.

## Trade-offs / when NOT to use

- A snapshot is right when the past must not move (what the customer was promised). For a value
  that should follow the source — an airport's name on a ticket list — a reference is better.
- Share-locking the fares makes fare changes wait for holds in progress (milliseconds each) and
  holds wait for an open fare change. With frequent fare changes on a busy flight that queue would
  matter; there is no fare-change endpoint yet.
- `number` caps amounts at 2^53 − 1 đồng. A system summing revenue across many flights in one
  number would need `bigint` or decimals.

## Gotchas

- `price_in_cents` held đồng. A name is not a unit; the unit belongs in the type or the column
  (`amount_vnd`).
- `pg` hands `bigint` back as a string — compare with `"4200000"` in raw-SQL tests, never assume a
  number.
- A CTE with `FOR SHARE` that nothing reads takes no lock (see above).
- The race test "no booking mixes old and new fares" passes **without** the lock: one statement
  already reads one snapshot. The lock is proved by the tests that make one side wait (B1/B2), not
  by that one.

## Related

- Decision 13, BR-MONEY-01, BR-FLT-09, BR-BOOK-03: [domain-model](../product/domain-model.md)
- [ADR-004, Day 49A addendum](../adr/004-optimistic-concurrency-control.md): measured race tests
- Code: `api/src/money/money.ts`, `SHARE_LOCKED_FARES` and `toHeldSeat` in
  `api/src/bookings/postgres/postgres-booking-repository.ts`, `api/src/bookings/booking-total.ts`
- Tests: `api/tests/money.test.ts`, `api/tests/integration/postgres-fare-snapshot.integration.test.ts`
- [evolving-event-contracts.md](./evolving-event-contracts.md): `fares` and `total` added as optional
  fields, `priceInCents` deprecated rather than removed
- [reference-data-and-seat-layouts.md](./reference-data-and-seat-layouts.md): the layout snapshot

# Exclusion constraints: a rule about other rows

## The problem it solves

BR-FLT-03: an aircraft never flies two flights whose windows `[departure, arrival + 45 min)` overlap. The obvious code is "SELECT overlapping flights; if none, INSERT". Two admins doing that at the same moment both see an empty schedule and both insert. Race test B shows it: 10 callers, 10 overlapping rows in a table without the constraint.

The seat counter (Day 39) was solved with a conditional `UPDATE ... WHERE available_seats > 0`, because the rule lived on **one row**. Here the conflict is between a new row and **other rows**, so no single-row `WHERE` can see it. A `UNIQUE` index cannot either: it compares for equality, not overlap.

## How it works

Migration `AddAircraftScheduleExclusion`:

```sql
EXCLUDE USING gist (
  aircraft_id WITH =,
  flight_aircraft_occupancy(departure_at, arrival_at) WITH &&
) WHERE (status <> 'CANCELLED')
```

"No two rows where `aircraft_id` is equal **and** the ranges overlap (`&&`)." Postgres checks it on every insert or update, under its own locking, so concurrent inserts cannot both pass. A violation is SQLSTATE `23P01` with the constraint name, which the adapter maps to `aircraft-unavailable` → `409 AIRCRAFT_UNAVAILABLE`.

Pieces that were needed:
- **`btree_gist`**: GiST indexes ranges, but `uuid WITH =` needs btree behaviour inside GiST. The extension is *trusted*, so the database owner (`booking`) can create it without a superuser.
- **An `IMMUTABLE` wrapper**: index expressions must be immutable. `timestamptz + interval` is only `STABLE`, because adding "1 day" depends on the session time zone. Adding minutes does not, so `flight_aircraft_occupancy()` is declared `IMMUTABLE` and that is true.
- **Half-open `[)`**: the next flight may depart exactly at arrival + 45 min. The contract test pins both sides: +45 is allowed, +44 is rejected.
- **Partial (`WHERE status <> 'CANCELLED'`)**: a cancelled flight frees its aircraft.

## Trade-offs / when NOT to use

- The 45 minutes now lives in two places: `AIRCRAFT_TURNAROUND_MS` for the fake, and the SQL function. The contract test runs the same boundary cases on both.
- Changing the turnaround means a migration (replace the function, rebuild the index).
- For a rule about a single row, a conditional `UPDATE` is simpler. Use an exclusion constraint only for overlap/"no two rows like this" rules.

## Gotchas

- **Concurrent inserts can deadlock (`40P01`) instead of failing with `23P01`.** A unique btree index has a special path for two transactions inserting the same key; an exclusion constraint does not. Each transaction writes its index entry, then waits for the other's uncommitted conflicting row → a lock cycle, and Postgres aborts one. Race test B hit it in 2 runs out of 8, and it surfaced as a 500. Fixed by also mapping `40P01` in `FlightRepository.create` to `aircraft-unavailable`. That is safe because the insert is the first write of the transaction, so this wait is the only cycle it can be in. A deterministic test forces the cycle (`postgres-flight-repository.integration.test.ts`).
- A flaky race test is information. The first fix attempt (replace `sleep` with a barrier) made the interleaving deterministic, but the failure stayed. That proved the problem was in the code, not in the test.
- The first contract migration was refused on dev data (`VN999` with an unknown airport, `VN123` with no aircraft). With `migrationsTransactionMode: "each"` the expand and backfill stayed applied, so fixing two rows and re-running was enough.

## Interview Q&A

**How do you stop two overlapping bookings of the same resource?**
A Postgres exclusion constraint on (resource `=`, time range `&&`). The database enforces it atomically; checking in application code first is only a nicer error message, not the guard.

**Why not SELECT then INSERT inside a transaction?**
Under READ COMMITTED both transactions see the empty schedule. You would need SERIALIZABLE (and retries) or a lock on the aircraft row. The constraint is simpler and cannot be forgotten by a new code path.

**What surprised you?**
The deadlock: concurrent conflicting inserts can produce `40P01`, not `23P01`, so the error mapping must cover both.

## Related

- Code: `api/src/postgres/migrations/1790461600000-AddAircraftScheduleExclusion.ts`, `api/src/flights/postgres/postgres-flight-repository.ts` (`create`), `api/src/postgres/postgres-errors.ts`
- Tests: `api/tests/contracts/flight-repository.contract.ts`, `api/tests/integration/flight-schedule-race.postgres.integration.test.ts`
- BR-FLT-03/08 in `docs/product/domain-model.md`; ADR-004 (optimistic concurrency for seats)

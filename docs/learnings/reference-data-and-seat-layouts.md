# Reference data and seat layouts

## The problem it solves

Bookings are transactional data: many users create them all the time and compete for the same seats, so OCC and race tests matter. Airports and aircraft are the opposite. Only an admin creates them, they almost never change, and nearly every flow reads them. The risk is not a race but **wrong data**: a malformed code, a time zone that does not exist, two seats at the same position. Once flights reference that data, fixing it is expensive. So reference data gets strict validation, database constraints, and change rules decided up front.

## How it works

### 1. Natural key vs surrogate key

An IATA code (`SGN`) is short, meaningful and readable in a URL, so making it the primary key is tempting. But codes are **reassigned** when an airport closes, and occasionally changed. As the key that every flight references, a changed code means rewriting every reference.

Chosen: `airports.id uuid` (stable, meaningless) plus `UNIQUE (code)` (the business identifier people and the API use). Domain-model Decision 6.

The code is normalized (`trim().toUpperCase()`) in **one** function (`normalizeAirportCode`) before it is saved or compared. The unique index on the normalized value is then enough for `sgn` and `SGN` to collide. `CHECK (code ~ '^[A-Z]{3}$')` is the last safety net. Registrations follow the same pattern (`normalizeRegistration`).

### 2. Time zones: an IANA name, never an offset

`+07:00` is an offset **at one moment**. `Europe/London` is a zone: `+00:00` in winter and `+01:00` in summer. If Heathrow stored `+00:00`, every summer flight would show the wrong local time by one hour. So instants stay UTC (`timestamptz`), the airport stores the zone name, and local times are computed when needed.

Validation is done with `Intl`, no library needed, but this Node showed why it must be done carefully (`isIanaTimeZone` in `api/src/airports/airport-validation.ts`):

| Approach | Problem found on Node 22 |
|---|---|
| `Intl.supportedValuesOf("timeZone").includes(z)` | The list holds canonical names only. This ICU lists `Asia/Saigon` and **not** `Asia/Ho_Chi_Minh`, so it would reject Vietnam's own zone |
| Store `resolvedOptions().timeZone` | Silently rewrites `Asia/Ho_Chi_Minh` to `Asia/Saigon` |
| `new Intl.DateTimeFormat(..., { timeZone })` alone | Also accepts `+07:00` and `EST` (→ `America/Panama`) |

The chosen check is a regex for the `Area/Location` shape (or `UTC`), then "does the formatter accept it". The value is stored **as given**.

**Validate on write, never on read.** Zone names get renamed and aliased between ICU versions (this is exactly the `Asia/Saigon` story). If reads re-validated, a Node upgrade could make existing rows "invalid" overnight.

### 3. A seat layout is a template; flights snapshot it

Seats belong to the aircraft and have **no status**. When a flight is scheduled (step 4), its FlightSeats are copied from the layout. If an admin then edits the layout, flights that already sold seats are unaffected. This is the same reasoning as the price snapshot (Day 43, Decision 4). Today there is no edit endpoint at all (BR-REF-05).

Model B was chosen: one row per seat, `PRIMARY KEY (aircraft_id, row, letter)`. The database itself rejects a duplicate position (BR-REF-03), and step 4 can generate FlightSeats with one `INSERT … SELECT`. JSONB would be simpler, but the database could not check it. A shared "configuration" table matches real airlines better, but no user story needs it yet.

`create()` writes the aircraft and all seats atomically. Inside a `TransactionRunner` it joins that transaction; called outside one (the seed script), it opens its own. The test `aircraft-rollback.postgres.integration.test.ts` makes seat 150 a duplicate and counts **0** aircraft and **0** seats afterwards.

### 4. Input amplification

A compact layout (`rows 4–40, letters ABCDEF`) expanded server-side is good API design. Without limits, a 40-byte request (`toRow: 1000000000`) would allocate a billion seats: a denial of service, even from an admin, because tokens leak.

Rules applied in `expandSeatLayout` (`api/src/aircraft/seat-layout.ts`):
- **Every multiplying input has an upper bound**: ≤ 10 cabins, rows 1–99, ≤ 10 letters, ≤ 900 seats in total.
- **Check bounds before doing the work.** The total is computed from the numbers, `(toRow − fromRow + 1) × letters`, never by expanding first. The cabin array's length is checked before it is walked, and the letters string's length before it is split.
- The test proves it with issue counts: a 100,000-element `cabins` array returns exactly **one** issue (`INVALID_CABIN_COUNT`), so the elements were never looked at.

All problems are returned at once, like `validateCreateFlightInput`. An admin composing a complex layout should not have to resubmit once per mistake.

## Trade-offs / when NOT to use

- **Surrogate keys cost a join.** "Flights from SGN" will need `airports.code → id`. That is cheap, and it is the price of a stable key.
- **No events for reference data.** Nothing consumes "airport registered" (Day 27 rule), so the audit row is enough.
- **No full CRUD.** Only create and list exist, because only those have user stories. Editing a layout needs BR-REF-05's condition (no flight uses the aircraft), which only becomes checkable in step 3.
- **The seed writes no audit rows.** It is not an account acting; it calls repositories directly.

## Gotchas

- `INSERT` of a whole layout is **one** multi-row statement (`repository.insert(array)`), not hundreds of round trips.
- Only the business unique constraint (`UQ_aircraft_registration`, `UQ_airports_code`) maps to `duplicate`. A primary-key or `PK_seats` violation is a bug and must still throw. That is why `isUniqueViolation` takes a constraint name.
- `row` is a Postgres keyword. It works as a quoted column name; TypeORM quotes it.

## Related

- `docs/product/domain-model.md`: Decisions 6–8, BR-REF-01..06
- `docs/product/scope.md`: US-REF-01/02/03
- `docs/learnings/domain-model-and-aggregates.md`: Aircraft + Seats as one aggregate
- `.cursor/progress/DAY-45.md`

# Validating airports and seats (input validation in layers)

## The problem it solves

Airports and seat layouts come from untrusted JSON (`unknown`). Once flights reference them, bad data (code `sg`, zone `+07:00`, two seats `12A`) is expensive to fix. So every write goes through several independent checks, each catching what the others cannot.

## How it works

Four layers, from the outside in:

| Layer | Where | Catches | Example |
|---|---|---|---|
| 1. Shape | `validation.ts` (`isPlainObject`, `isNonEmptyString`) | wrong type, missing field | body is an array, `city: 5` |
| 2. Format and business rules | `airport-validation.ts`, `seat-position.ts`, `seat-layout.ts` | right type, wrong content | `code: "SG"`, `toRow < fromRow`, overlapping cabins |
| 3. Use case | `register-airport.ts`, `register-aircraft.ts` | things that need the DB | duplicate code → `{ outcome: "duplicate" }` |
| 4. Database | migration `CreateAirportsAndAircraft` | anything that bypassed 1–3 | `CHECK (code ~ '^[A-Z]{3}$')`, `PRIMARY KEY (aircraft_id, row, letter)` |

Layers 1–2 are **pure functions** returning `ValidationResult<T>`: `{ success: true, value }` or `{ success: false, issues[] }`. No throw, no I/O, so they are trivial to unit test.

### Airport (`validateRegisterAirportInput`)

1. Body must be an object.
2. `code`, `name`, `city`, `timeZone`: non-empty string, ≤ 100 chars, trimmed.
3. `code` → `normalizeAirportCode` (`trim().toUpperCase()`), then must match `^[A-Z]{3}$`. `" sgn "` is saved as `SGN`.
4. `timeZone` → regex for the `Area/Location` shape, then `new Intl.DateTimeFormat(..., { timeZone })` must not throw. `Asia/Ho_Chi_Minh` passes; `+07:00`, `EST`, `asia/ho_chi_minh` fail.

Uniqueness of `code` is **not** checked here. `UNIQUE (code)` decides, and the repository turns the violation into `duplicate`. Checking "does it exist?" first would be a race (two requests both see "no").

### Seat (`seat-position.ts`, `expandSeatLayout`)

A seat is `{ row: 1–99, letter: A–K }`, written `12A`. Lower case is rejected, not fixed.

The client sends **cabins**, not seats:

```json
{ "cabins": [
  { "fareClass": "BUSINESS", "fromRow": 1, "toRow": 2,  "seatLetters": "AC" },
  { "fareClass": "ECONOMY",  "fromRow": 3, "toRow": 30, "seatLetters": "ABCDEF" }
]}
```

Order of checks in `expandSeatLayout`:

1. `cabins` is an array of 1–10 items (checked **before** looping).
2. Per cabin: fare class is `ECONOMY`/`BUSINESS`, rows are integers 1–99, `fromRow ≤ toRow`, letters are 1–10 chars from A–K with no repeats. Issues are collected, the loop does not stop at the first.
3. Cross-cabin: no two cabins share a row (`CABIN_ROWS_OVERLAP`, names the seat like `5A` if the letter also repeats). This runs only if every cabin is valid, because overlap maths on garbage numbers is meaningless.
4. Total seats = `Σ rows × letters`, computed from the numbers, must be ≤ 900.
5. Only now expand into `LayoutSeat[]`.

Result above: 4 + 168 = 172 seats.

## Why it is designed this way

- **Return all issues at once.** An admin fixing a layout should not resubmit once per mistake.
- **Validate before work (input amplification).** `fromRow: 1, toRow: 99, seatLetters: "ABCDEFGHIJ"` × many cabins is tiny input and huge output. Bound every multiplier and compute the total before allocating.
- **Normalize in one function.** `normalizeAirportCode` is the only place that upper-cases, so `sgn` and `SGN` always collide on the unique index.
- **Validate time zones on write, never on read.** ICU renames and aliases zones between versions (`Asia/Saigon` vs `Asia/Ho_Chi_Minh`); re-validating stored rows on read could break old data after a Node upgrade.
- **Defense in depth.** The app gives friendly messages; the DB is the last line if another writer (script, migration, future service) skips the app.

## Trade-offs / when NOT to use

- Hand-written validation is verbose. With many more entities a schema library (zod) would pay off; at this size it keeps the learning visible. Introduce one when the repetition hurts, not before.
- Two sources of truth for the rules (code and `CHECK`). They can drift. Mitigation: the migration comments name the matching business rule (BR-REF-xx) and contract/integration tests hit the real DB.
- DB `CHECK` cannot validate IANA zones (Postgres does not know them), so that one rule lives only in the app.

## Gotchas

- `Intl.supportedValuesOf("timeZone")` looks like the obvious check but lacks `Asia/Ho_Chi_Minh` on this Node.
- `new Intl.DateTimeFormat` alone accepts `+07:00` and `EST`, so the regex is needed too.
- Storing `resolvedOptions().timeZone` silently rewrites the user's value.
- Only business unique constraints (`UQ_airports_code`, `UQ_aircraft_registration`) map to `duplicate`; a `PK_seats` violation is a bug and must throw.

## Interview Q&A

**Where do you validate, and why more than once?**
Shape and format in a pure function at the edge of the use case, existence/uniqueness through the DB, and `CHECK`/`PRIMARY KEY` as a safety net. Each layer catches something the others can't, and the DB protects against writers that skip the app.

**Why not check "does this code exist" before inserting?**
Check-then-insert is a race. Let the `UNIQUE` constraint decide and map the violation to a `duplicate` outcome.

**Why return a result object instead of throwing?**
Invalid input is an expected outcome that the caller must branch on (HTTP 422 vs 409 vs 201). Exceptions are for bugs and infrastructure failures.

**What is input amplification? How did you prevent it?**
A small request causing large server work (a 40-byte body asking for a million seats). Every multiplying field has an upper bound, bounds are checked before looping/splitting, and the seat total is computed arithmetically before expansion.

**Why store the time zone as an IANA name instead of `+07:00`?**
An offset is valid at one instant. `Europe/London` is +0 in winter and +1 in summer, so an offset gives wrong local times half the year. Store instants in UTC and the zone name on the airport.

**Why is `code` not the primary key?**
Codes get reassigned. A surrogate `uuid` key stays stable; `UNIQUE (code)` is the business identifier.

**Why report every error instead of the first?**
Better UX for complex payloads, and cheap because validation is pure.

## Related

- `docs/learnings/reference-data-and-seat-layouts.md`: keys, layout snapshot, why Model B (one row per seat)
- `docs/product/domain-model.md`: BR-REF-01..06
- Code: `api/src/airports/airport-validation.ts`, `api/src/aircraft/seat-position.ts`, `api/src/aircraft/seat-layout.ts`, `api/src/airports/register-airport.ts`

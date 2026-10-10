# CURRENT PROGRESS

**Last completed day:** Day 45
**Current day:** Day 45 — airports + aircraft with seat layouts (phase D step 2)
**Status:** ✅ Complete — unit 238/238, integration 64/64, end-to-end verified (curl + psql).
Reference data exists: `airports` (uuid key, unique normalized IATA code, IANA time zone
validated on write), `aircraft` (unique registration) and `seats` (one row per position,
PK `aircraft_id, row, letter`). Layouts are sent compactly and expanded by the pure
`expandSeatLayout`, with size limits checked before expansion. Admin-only writes with audit,
public airport list, idempotent dev seed. `GET /api/flights/:id` with a malformed id is now
`404`. Flights do not reference airports/aircraft yet. Unit tests 186 → 238.

## Day 45 delivered

```text
Step 0: domain-model Decisions 6–8, BR-REF-04/05/06; scope.md layout format
Step 1: CreateAirportsAndAircraft migration + entities
Step 2: SeatPosition, expandSeatLayout, airport/aircraft validation (pure)
Step 3: two async ports, fakes, Postgres adapters, contract tests on both
  tiers, rollback test (aircraft + seats atomic)
Step 4: RegisterAirport, ListAirports, RegisterAircraft, GetFlight; routes;
  audit actions
Step 5: seed:reference, Postman folder, README, learnings, DAY-45
```

## Previous day (Day 44) recap

```text
Booking ownership: owner_account_id, owner-scoped queries via
BookingAccessScope, 404 for other accounts' bookings, account audit actors.
```

## Next

Day 46 — Phase D step 3: flights reference airports/aircraft + flight lifecycle (US-FLT-01/02,
BR-FLT-03/05/06), per [`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).

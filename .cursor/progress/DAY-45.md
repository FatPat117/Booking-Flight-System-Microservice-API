# Day 45 — Session Notes

**Date:** 2026-10-10
**Theme:** Airports + aircraft with seat layouts — phase D step 2 (US-REF-01/02/03, BR-REF-01..06)
**Status:** ✅ Complete — unit 238/238, integration 64/64, six end-to-end scenarios verified.

## Why

```text
FlightSeats (step 4) are generated from an aircraft's seat layout, and
flights (step 3) must reference real airports. Neither existed. Today is a
pure addition: flights and bookings are untouched.
Reference data is the opposite of bookings: admin-only, rarely changed,
read everywhere. The risk is wrong data, not races, so the weight is on
validation, database constraints and change rules decided up front.
```

## Endpoints (each traced to a story)

```text
POST /api/airports   US-REF-01  admin   201 / 409 AIRPORT_ALREADY_EXISTS / 422
GET  /api/airports   US-REF-03  public  paged, ordered by code
POST /api/aircraft   US-REF-02  admin   201 (seat counts) / 409 AIRCRAFT_ALREADY_EXISTS / 422
GET  /api/flights/:id  (fix)    malformed id → 404, was a Postgres 500
No GET/PUT/DELETE for aircraft: no story asks for them.
```

## Decisions

```text
Airport key: uuid + UNIQUE(code), not the IATA code (codes get reassigned;
  domain-model Decision 6, which changed Day 43's "natural key"). Flight
  attributes become originAirportId/destinationAirportId in step 3.
Time zone: IANA name, validated on write only, stored as given (Decision 7).
Seat layout: model B, one `seats` row per position, PK (aircraft_id, row,
  letter) = BR-REF-03 in the database (Decision 8). A layout is a template;
  flights will snapshot it.
BR-REF-05: no layout edit endpoint; if one comes, only while no flight uses
  the aircraft. BR-REF-06: size limits, checked before expansion.
Malformed ids: a GetFlight use case with isUuid, like GetBooking. No shared
  middleware: each resource has its own 404 code and only 3 routes take an id.
Validation returns every issue at once (same as CreateFlight).
No events (Day 27 rule: no consumer), audit only. No Location header (no
  GET-by-id route to point at).
```

## What was built

```text
Step 0: domain-model (Airport fields, Decisions 6–8, BR-REF-04/05/06),
  scope.md (compact layout format, 12A wording), learnings note on
  expand/contract being two deploys, README limitation: role changes apply
  only at the next login.
Step 1: CreateAirportsAndAircraft migration (airports, aircraft, seats) +
  three entities.
Step 2: pure functions — SeatPosition (parse/format), expandSeatLayout
  (bounds → per-cabin checks → overlaps naming the seat → expand last),
  airport/aircraft validation; shared validation.ts (type guards were about
  to get their 3rd and 4th copies).
Step 3: AirportRepository, AircraftRepository (async ports), fakes,
  Postgres adapters, contract tests on both tiers, rollback integration
  test. postgres-errors.ts: isUniqueViolation(error, constraint).
Step 4: RegisterAirport, ListAirports, RegisterAircraft, GetFlight; audit
  AIRPORT_REGISTERED / AIRCRAFT_REGISTERED (no migration — loose CHECK);
  routes; AppDependencies swaps flightRepository for getFlight.
Step 5: seed script (idempotent, no audit), Postman folder, README,
  domain-model Existing column, learnings note, this file.
```

## Finding: Intl and Asia/Ho_Chi_Minh

```text
On this Node 22, ICU treats Asia/Saigon as canonical:
  Intl.supportedValuesOf("timeZone") lists Asia/Saigon, NOT Asia/Ho_Chi_Minh
  resolvedOptions().timeZone rewrites Asia/Ho_Chi_Minh → Asia/Saigon
  DateTimeFormat also accepts "+07:00" and "EST" (→ America/Panama)
So: Area/Location regex (or UTC) + "does DateTimeFormat accept it", store as
given, never re-validate on read. The Pause & Think question turned out to
be a live problem, not a hypothetical.
```

## Proof the tests bite

```text
Postgres: AircraftRepository.create() without its own transaction →
  exactly 2 failures: the rollback test (seat 150 duplicates seat 1 →
  expected 0 aircraft / 0 seats) and the contract case "a layout with a
  duplicated position throws and stores nothing". Reverted → 12/12.
Amplification: a 100,000-element cabins array returns exactly one issue
  (INVALID_CABIN_COUNT) — its elements were never walked.
```

## Test count reconciliation

```text
Unit: 186 before → 238 after (+52, nothing removed):
  seat-position 3, seat-layout 11, airport-validation 7,
  aircraft-validation 5, airport contract 3, aircraft contract 6,
  register-airport 3, register-aircraft 3, get-flight 3,
  reference-data.api 7, flights.api +1.
  (The existing flights.api 404 test now uses a valid unknown uuid.)
Integration: 52 before → 64 after (+12): reference-data contract 9
  (3 airport + 6 aircraft), aircraft rollback 3.
```

## End-to-end (docker-compose, dev servers running)

```text
Seed: run 1 → 4 airports + 2 aircraft created (176 and 307 seats);
  run 2 → every item "duplicate", no error. 0 audit rows from the seed.
  Expanded afterwards to 25 airports (12 VN, 13 international incl. DST
  zones) and 8 aircraft (68–348 seats: ATR 72 and A320neo single-class,
  an A321 with no row 13, A321neo, 787-9, 787-10, A350): the new items
  were created, the original 6 came back duplicate; a further run created
  nothing. 1,822 seats in booking_db (incl. the e2e VN-A322).
1. Admin POST airport "cxr" → 201, code "CXR".                         ✅
2. POST "CXR" again → 409 AIRPORT_ALREADY_EXISTS.                     ✅
3. timeZone "Asia/Not_A_Zone" → 422 INVALID_TIME_ZONE on timeZone.    ✅
4. Admin POST aircraft vn-a322 (business 1–2 ACDF, economy 3–7 ABCDEF)
   → 201 { seatCount 38, ECONOMY 30, BUSINESS 8 }; psql: VN-A322
   BUSINESS 8, ECONOMY 30.                                             ✅
5. Overlapping cabins (VN-A399) → 422 "row 12 also belongs to
   cabins[0] (seat 12A is listed twice)"; psql: 0 aircraft rows.      ✅
6. bob (role=user) POST airport → 403 FORBIDDEN.                      ✅
Extra: GET /api/flights/abc → 404 FLIGHT_NOT_FOUND; GET /api/airports →
  CXR, DAD, HAN, LHR, SGN (total 5).
audit_logs: AIRPORT_REGISTERED and AIRCRAFT_REGISTERED, actor
  account/add4f392… (alice), metadata { code, timeZone } and
  { registration, economySeats 30, businessSeats 8 }.
```

## Not today

```text
Flights referencing airports/aircraft, flight lifecycle (step 3).
GET routes for one airport/aircraft, layout editing (BR-REF-05 condition
  becomes checkable in step 3).
Search by local date using the airport's time zone (step 8).
```

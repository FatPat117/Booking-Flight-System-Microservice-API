# Day 46 — Session Notes

**Date:** 2026-10-10
**Theme:** Flights reference airports/aircraft + flight lifecycle — phase D step 3 (US-FLT-01/02, BR-FLT-03/05/06/08)
**Status:** ✅ Complete — unit 309/309, flight-notifier 6/6, integration 88/88, race tests 10× in a row, end-to-end verified.

## Why

```text
The first breaking change to a table that already has data, and three readers:
bookings (FK + reserveSeat), the read routes, and FlightCreatedEvent consumed
by flight-notifier. Free-text origin/destination become FKs to airports, a
flight gets an aircraft and a status, an aircraft can no longer fly two
flights at once, and the event grows without breaking its consumer.
```

## Endpoints (each traced to a story)

```text
POST /api/flights          US-FLT-01  admin  body: IATA codes + aircraftRegistration
                                             (availableSeats → 422 UNSUPPORTED_FIELD)
                                             201 SCHEDULED, seats from the aircraft /
                                             409 AIRCRAFT_UNAVAILABLE / 422 UNKNOWN_*
POST /api/flights/:id/open US-FLT-02  admin  200 OPEN / 409 INVALID_FLIGHT_STATUS
                                             (NOT_ALLOWED | DEPARTURE_TOO_SOON) /
                                             409 FLIGHT_STATUS_CHANGED / 404
GET  /api/flights(/:id)    BR-FLT-05/06      status = effective status
POST .../bookings          BR-FLT-06         409 SALES_CLOSED unless effectively OPEN
No CANCELLED route: comes with the booking cascade (step 9).
```

## Decisions

```text
User:
- CLOSED/DEPARTED derived from the clock, never stored (ADR-008, Decision 9).
  Stored: SCHEDULED/OPEN/CANCELLED. No job, no job-vs-booker race.
- → CANCELLED not reachable until step 9 (the table has it; no route).
- aircraft_id NOT NULL; existing flights get an aircraft by hand.
- Turnaround 45 min (BR-FLT-08), window [departure, arrival + 45m).
- API takes IATA codes + registration; the use case resolves ids.
- POST /api/flights/:id/open (a command, not PATCH status).
- BR-FLT-06 checked inside the seat-hold UPDATE.
- Etc/* time zones rejected (BR-REF-04).
- 40P01 on concurrent overlapping inserts → aircraft-unavailable (found by
  race test B, see Finding).
Claude:
- availableSeats removed from input, rejected loudly (422), not ignored.
- Responses keep origin/destination as IATA codes (join, not stored) and add
  the ids + status. FlightView = Flight with the effective status.
- Legacy flights backfilled OPEN (they were on sale); new flights SCHEDULED.
- No "departure in the future" rule on create; opening needs > 1 h.
- Event evolves additively; producer maps the payload field by field.
```

## What was built

```text
Step 0  domain-model (lifecycle rows "derived", Decision 9, BR-FLT-03/08,
        BR-REF-04), scope.md (US-FLT-01 body, US-OPS-02), ADR-008, Etc/* regex.
Step 1  4 migrations, migrationsTransactionMode "each":
        ExpandFlightReferences (nullable columns) → BackfillFlightReferences
        (airports by upper(code), status OPEN) → ContractFlightReferences
        (DO-block refuses with a list + HINT; NOT NULL, FKs, CHECKs, drops the
        text columns; full down) → AddAircraftScheduleExclusion (btree_gist,
        IMMUTABLE flight_aircraft_occupancy(), EXCL_flights_aircraft_schedule).
Step 2  flight-lifecycle.ts: stored/derived statuses, effectiveFlightStatus,
        isBookable, FLIGHT_TRANSITIONS guard table, transitionFlight. 37 tests,
        a hand-written ALLOWED list independent of the table.
Step 3  Flight type + entity; FlightRepository.create maps 23505/23P01/23503
        by constraint; changeStatus compare-and-set; findByCode /
        findByRegistration; reserveSeat(flightId, now) with the sales window in
        its WHERE → sales-closed; CreateFlight new body; fixtures/flights.ts,
        integration flight-references.ts; flight repository contract (11 cases).
Step 4  FlightView/toFlightView; OpenFlight use case + route; getFlight /
        listFlights take a clock; FLIGHT_OPENED audit; bookings.api opens
        flights through the route.
Step 5  FlightCreatedEvent: 4 optional fields (present-but-empty rejected),
        toFlightCreatedPayload, notifier logs aircraftId/status.
Step 6  race tests, 40P01 fix + deterministic test, e2e, Postman folder,
        README, domain-model Existing column, 2 learnings notes.
```

## Migration checkpoint (dev data, Step 1)

```text
Before: VN123 SGN→HAN (no aircraft). Inserted VN999 with origin XXX.
Run 1: Expand + Backfill committed; Contract refused, listing
  VN999 (origin XXX, no aircraft) and VN123 (no aircraft), with a HINT.
Manual fix (cannot be guessed, so done by hand):
  DELETE FROM flights WHERE flight_number = 'VN999' AND origin = 'XXX';
  UPDATE flights SET aircraft_id = (SELECT id FROM aircraft
    WHERE registration = 'VN-A321') WHERE flight_number = 'VN123';
Run 2: Contract + AddAircraftScheduleExclusion applied.
Exclusion by hand: overlap → 23P01; departure = arrival + 45m → ok;
  + 44m → 23P01; CANCELLED overlap → ok; other aircraft → ok;
  status 'CLOSED' → CHK_flights_status. btree_gist owned by booking.
```

## Finding: concurrent overlapping inserts deadlock

```text
Race test B flaked 2/8 runs. Replacing its sleep with a barrier made the
interleaving deterministic but the failure stayed: 40P01 deadlock detected,
not 23P01. An exclusion constraint has no special path for concurrent
inserts (a unique btree does): each transaction writes its index entry, then
waits on the other's uncommitted row → lock cycle → Postgres aborts one →
unmapped → 500.
Fix: FlightRepository.create maps 40P01 → aircraft-unavailable (409). Safe:
the insert is CreateFlight's first write, so that wait is the only cycle.
If the winner later rolls back too, the slot stays free; the 409 is
retryable (README limitation).
Test: postgres-flight-repository integration forces the cycle with two
transactions (X | Y overlaps X and Z | Z, X and Z disjoint).
```

## Proof the tests bite

```text
Lifecycle table + CLOSED → OPEN: 3 lifecycle tests fail.
changeStatus without AND status = :expected: contract "stale status" fails
  (Step 3); race test C: expected 1 opened, actual 10 (Step 6).
reserveSeat without the OPEN/time condition: 3 sales-closed contract cases.
OpenFlight without the transition check: 2 flights.api tests (open again,
  DEPARTURE_TOO_SOON).
create without the 40P01 mapping: deadlock test fails with 40P01.
All restored; grep MUTATION src → 0.
```

## Test count reconciliation

```text
Unit (api): 238 before → 309 after (+71)
  Step 0  airport-validation Etc/*                       +1  → 239
  Step 2  flight-lifecycle                              +37  → 276
  Step 3  flight repository contract (fake) 11, booking contract +4,
          airport +1, aircraft +1, create-flight +3, create-booking +1,
          flights.api net +3 (−1 "accepts availableSeats=0", +4)  +24 → 300
  Step 4  flights.api open +6, get-flight +1, list-flights +1,
          bookings.api SALES_CLOSED +1                    +9 → 309
flight-notifier: 4 → 6 (+2: Day 46 shape, present-but-empty rejected).
Integration: 64 → 88 (+24)
  Step 3  flight contract on Postgres 11, booking contract +4,
          airport +1, aircraft +1, FK reference-not-found +1,
          23P01 constraint name +1                       +19 → 83
  Step 6  race A, B, C, cancelled-frees +4, deadlock +1   +5 → 88
Race file run 10× in a row: 4/4 each time.
```

## End-to-end (docker-compose app + notifier rebuilt, identity dev server)

```text
Integration tests TRUNCATE booking_db, so the seed was re-run first
(25 airports, 8 aircraft). alice = admin, bob = user.
1. VN461 SGN→HAN on VN-A323 → 201, availableSeats 194, SCHEDULED.       ✅
2. VN462 on VN-A323 departing 30 min after VN461 lands → 409
   AIRCRAFT_UNAVAILABLE; exactly 45 min after → 201.                     ✅
3. SGN→SGN → 422 ORIGIN_EQUALS_DESTINATION; body with availableSeats →
   422 [availableSeats, UNSUPPORTED_FIELD].                              ✅
4. Open VN461 → 200 OPEN; again → 409 INVALID_FLIGHT_STATUS
   "Cannot open a flight that is OPEN" [NOT_ALLOWED]; a flight departing
   in 30 min → 409 [DEPARTURE_TOO_SOON]; bob → 403.                      ✅
5. flight-notifier: flight_created_consumed for VN461/VN462/VN465 with
   aircraftId + status SCHEDULED; flight-created.dlq and
   booking-created.dlq empty (booking-cancelled holds 1 message: no
   consumer since Day 28, unrelated).                                    ✅
6. bob books VN461 → 201 (193 seats left); books SCHEDULED VN462 → 409
   SALES_CLOSED.                                                          ✅
Extra, derived CLOSED live: VN465 (departs in ~30 min) set to OPEN in psql
  → GET reads CLOSED, bob's booking → 409 SALES_CLOSED; stored row still
  OPEN.
audit_logs: FLIGHT_CREATED ×3 (metadata aircraftRegistration) and
  FLIGHT_OPENED { VN461, previousStatus SCHEDULED }, actor account/add4f392…
  (alice).
```

## Not today

```text
→ CANCELLED and the booking cascade (step 9); events for status changes.
FlightSeat inventory; availableSeats is still a counter (step 4).
Separate read model for flights (only status is mapped, via FlightView).
Making the new event fields required / dropping origin/destination (a later
  contract step, once no old-shape message remains).
Search by local date with the airport's time zone (step 8).
```

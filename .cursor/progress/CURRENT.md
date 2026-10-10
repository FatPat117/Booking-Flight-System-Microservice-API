# CURRENT PROGRESS

**Last completed day:** Day 46
**Current day:** Day 46 — flights reference airports/aircraft + flight lifecycle (phase D step 3)
**Status:** ✅ Complete — unit 309/309, flight-notifier 6/6, integration 88/88, race tests
10× in a row, end-to-end verified (curl + psql + notifier logs).
Flights reference `airports` and `aircraft` by FK (expand → backfill → contract, one
transaction per migration). An aircraft cannot fly overlapping flights, including a 45-minute
turnaround: exclusion constraint `EXCL_flights_aircraft_schedule`, race-tested, with the
`40P01` deadlock it can raise mapped to `409`. Stored statuses `SCHEDULED/OPEN/CANCELLED`;
`CLOSED/DEPARTED` derived from the clock (ADR-008). `POST /api/flights/:id/open` with a
lifecycle table and compare-and-set; booking needs an effectively `OPEN` flight
(`409 SALES_CLOSED`). `flight-created` gained optional fields without breaking the consumer.

## Day 46 delivered

```text
Step 0: domain-model Decision 9, BR-FLT-03/08, BR-REF-04 (Etc/*), ADR-008
Step 1: 4 migrations (expand, backfill, contract, exclusion), checkpoint on dev data
Step 2: flight-lifecycle.ts (pure state machine, 37 tests)
Step 3: repositories (create error mapping, changeStatus, reserveSeat sales window),
  CreateFlight new body, fixtures, flight repository contract
Step 4: OpenFlight + route, FlightView (effective status on reads)
Step 5: FlightCreatedEvent additive evolution, explicit producer mapping
Step 6: race tests A/B/C + deadlock fix, e2e, Postman, README, learnings, DAY-46
```

## Previous day (Day 45) recap

```text
Airports + aircraft with seat layouts: reference data, expandSeatLayout, admin
writes with audit, idempotent dev seed.
```

## Next

Day 47 — Phase D step 4: FlightSeat inventory + seat map (US-SEAT-01, BR-SEAT-01/03: seats
generated from the aircraft layout, availability derived instead of the `available_seats`
counter), per
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).

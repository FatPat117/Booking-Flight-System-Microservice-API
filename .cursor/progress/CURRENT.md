# CURRENT PROGRESS

**Last completed day:** Day 47
**Current day:** Day 47 — FlightSeat inventory + seat map (phase D step 4)
**Status:** ✅ Complete — unit 321/321, flight-notifier 6/6, identity 12/12, integration
102/102, race file 10× in a row, end-to-end verified (HTTP + psql + notifier logs + newman).
Each flight owns a copy of its aircraft's seats (`flight_seats`, expand → backfill → contract,
the contract refusing until the dev data was reconciled by hand). The `available_seats` counter
is gone: `availableSeats` is counted on read (scalar subquery, partial index, index-only scan).
Booking claims the lowest free seat in one statement (`FOR UPDATE OF seat SKIP LOCKED FOR SHARE
OF flight`) and shows it as `seat`; cancel releases it in the same statement. Public
`GET /api/flights/:id/seats` with no booking/owner data (allow-list test over every key).
Control race tests measured what `SKIP LOCKED` buys on Postgres: no false sold-outs without it,
but a lock queue — ADR-004 addendum records the measured trade-off.

## Day 47 delivered

```text
Step 0: Day 46 leftovers (40P01 assumption, IMMUTABLE note, booking-cancelled limitation)
Step 1: domain-model Decision 10 (copy not reference, link on flight_seats.booking_id,
  AVAILABLE/BOOKED, one seat per booking, deferred FK)
Step 2: 3 migrations (CreateFlightSeats, BackfillFlightSeats, ContractFlightSeats) on shaped
  dev data; refusal → human decisions → applied; 6 constraint probes
Step 3: FlightRepository.create copies the layout atomically; derived availableSeats
Step 4: reserveSeat with SKIP LOCKED, cancel releases via data-modifying CTEs, Booking.seat,
  ADR-004 addendum
Step 5: findSeats + GetFlightSeatMap + public route; sold-out list test; EXPLAIN recorded
Step 6: race tests A–E (+C1/C2 controls), mutations, e2e, Postman folder, README, docs
```

## Previous day (Day 46) recap

```text
Flights reference airports/aircraft by FK; aircraft schedule exclusion constraint (45 min
turnaround); SCHEDULED/OPEN/CANCELLED stored, CLOSED/DEPARTED derived (ADR-008); open route.
```

## Next

Day 48 — Phase D step 5: multi-passenger booking — booking reference, all-or-nothing seat hold
(`HELD` + 15-minute expiry job), US-BOOK-01, US-SEAT-02, BR-BOOK-01..05, BR-SEAT-02, per
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried from Day 47 (see DAY-47 "Not today"): per-fare-class availability, seat code
on `booking-created`, deep-OFFSET cost of the counted flight list.

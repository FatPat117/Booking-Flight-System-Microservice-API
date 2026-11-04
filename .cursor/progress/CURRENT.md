# CURRENT PROGRESS

**Last completed day:** Day 51
**Current day:** Day 51 — Flight search + details with availability (phase D step 8)
**Status:** ✅ Complete — unit 580/580, notifier 19/19, identity 12/12 + integration 7/7 (on
`identity_test`), integration 260/260 (on `booking_test`), differential test over 50 seeded worlds,
end-to-end verified (HTTP + psql + newman Day 51 17/17). `GET /api/flights/search` finds flights on
sale on the origin airport's local dates (one sargable UTC interval, `idx_flights_route_departure`)
with room for N passengers in one fare class, sorted by departure or price, in keyset pages whose
cursor is bound to the search. `GET /api/flights/:id` adds availability per class and local times in
one statement through a `FlightSearch` read port. The system-picked hold now requires `fareClass`
(BR-BOOK-09 changed). Measured on 20 400 flights / 3.9 M seats: live counting is under 10 ms — no read
model needed yet (DAY-51 "Evidence for phase E"). Decision 17.

## Day 51 delivered

```text
Step 0: snapshot audit (confirmHold/expireDueHolds rely on "HELD seats never change", control test);
  simulator tests on an injected clock + spec reporter; 14 DLQ messages recorded and purged
Step 1: Decision 17, BR-FLT-10/11, BR-BOOK-09 changed, US-FLT-04/05 criteria
Step 2: onSaleSql shared, flightSearchSql, AddFlightSearchIndex, perf:search:seed/explain, evidence
Step 3: FlightSearch port + fake + contract (13 cases), one statement pinned, differential (50 seeds)
Step 4: keyset cursor, GET /api/flights/search, pages walked, OFFSET control; auto hold by fareClass
Step 5: findDetails (one statement), local-time helper, details per class + local times
Step 6: e2e 6 scenarios, Postman Day 51 (newman 17/17), README, learnings (EN + VI)
```

## Previous day (Day 50) recap

```text
Paid CONFIRMED booking cancelled > 24 h before departure is refunded through reconciliation;
seat change within the fare class in one ordered swap; cancel's pre-lock (snapshot bug).
```

## Next

Day 52 — Phase D step 9: flight cancellation cascade (US-OPS-01, BR-FLT-07): cancel every booking,
release seats, refund through reconciliation, notify — where the Day 47 review's deadlock hypothesis
gets tested. Per [`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried (see DAY-51 "Not today"): no fare-class filter or duration sort in search; the
free-seats partial index as the first lever if search gets hot; `REFUND_FAILED` has no endpoint or
alert; no way to learn a refund finished; the simulator's provider memory is in-process; the outbox
relay is not multi-instance safe and consumers do not dedupe by `eventId`; no fare-change endpoint,
deprecated `priceInCents`, removing the `booking-created` contract, the release `ORDER BY` survivor.

# CURRENT PROGRESS

**Last completed day:** Day 49A
**Current day:** Day 49A — Fares: `Money`, price per fare class, price snapshot at hold time (phase D step 6a)
**Status:** ✅ Complete — unit 400/400, flight-notifier 14/14, identity 12/12, integration
152/152, fare race file 10× in a row, end-to-end verified (HTTP + psql + app/notifier logs +
newman). Amounts are `Money` in whole đồng (never ×100), `bigint` capped at 2^53 − 1. A flight
has one fare per fare class (`flight_fares`) for exactly the classes its aircraft has
(BR-FLT-09: `422 MISSING_FARE` / `FARE_CLASS_NOT_ON_AIRCRAFT`); `priceInCents`/`currency` are
rejected. The hold statement reads the fares `FOR SHARE` and copies each seat's fare onto its
passenger (BR-BOOK-03); `Booking.total` is derived. Old data migrated expand → backfill →
contract (refused on dev data until BUSINESS/USD fares were set by hand). `flight-created` gains
`fares` (old fields deprecated), `booking-held` gains prices and `total`.

## Day 49A delivered

```text
Step 0: plan-test comments (deterministic without ANALYZE), "English notes are primary",
  phase D step 6 split into 6a fares / 6b payment / 6c payment failures (+ roadmap history row)
Step 1: domain-model Decision 13 (8 choices with reasons), BR-FLT-09
Step 2: api/src/money/money.ts (vnd, addMoney, sumMoney, parseVndFromDatabase) + 8 tests
Step 3: CreateFlightFares / BackfillFlightFares / ContractFlightFares / AddPassengerFareSnapshot;
  refused on shaped dev data, fixed by psql, re-run; down + up tested; safe-integer CHECKs added
Step 4: flights have fares (types, validation, CreateFlight BR-FLT-09, repository, seat map,
  flight-created event, fixtures with a two-class aircraft, contract + HTTP tests)
Step 5: hold statements read fares FOR SHARE (SHARE_LOCKED_FARES), HeldSeat with price,
  passengers priced, total derived (bookingTotal), booking-held prices, audit totalVnd
Step 6: race tests A–C with controls and gates, 5 mutations (FOR SHARE, unread CTE ×2, missing
  fare, ×100), e2e 6 scenarios, Postman (13 bodies + Day 49A folder), README, ADR-004 addendum,
  learnings (EN + VI)
```

## Previous day (Day 48B) recap

```text
Hold expiry: batched SKIP LOCKED job frees seats, reads derive EXPIRED, cancel checks the
deadline itself (409 BOOKING_EXPIRED); <= / > boundary; ordered-lock release CTE.
```

## Next

Day 49B — Phase D step 6b: simulated payment with an Idempotency-Key (US-PAY-01, BR-PAY-01..06).
The amount is `booking.total` (fixed at hold time since Day 49A). `HELD → CONFIRMED` takes the
`> now` side of BR-BOOK-10, seats `HELD → BOOKED` in the same transaction, and gets the
payment-vs-expiry race test. Then 49C: payment failures. Per
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried (see DAY-49A "Not today"): no fare-change endpoint, deprecated
`priceInCents` in `flight-created`, removing the `booking-created` contract once its queue is
empty, the release `ORDER BY` survivor, the outbox relay not being multi-instance safe.

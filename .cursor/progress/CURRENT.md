# CURRENT PROGRESS

**Last completed day:** Day 48A
**Current day:** Day 48A — Multi-passenger booking, booking reference, all-or-nothing hold
(phase D step 5, part 1)
**Status:** ✅ Complete — unit 351/351, flight-notifier 8/8, identity 12/12, integration
122/122, hold race file 10× in a row, end-to-end verified (HTTP + psql + notifier logs +
newman). A booking holds 1–9 passengers' seats (`{ passengers: [{ name, seat? }] }`, every seat
named or none) for 15 minutes as `HELD`, all or nothing, each hold one statement with its
verdict inside the `UPDATE`. Chosen seats are locked in (row, letter) order so opposite-order
requests cannot deadlock. 6-character reference (redrawn on `ON CONFLICT DO NOTHING`),
`GET /api/bookings/by-reference/:reference`. New `booking-held` event + notifier consumer.
Five migrations moved existing bookings to `CONFIRMED`/`CANCELLED` and into
`booking_passengers`.

## Day 48A delivered

```text
Step 0: Day 47 leftovers — C1/C2 defined, C3 (no row lock) measured 15–16 false sold-outs
  of 20; ListBookings query count pinned at 3 per page
Step 1: domain-model Decision 11 (legacy → CONFIRMED, link stays on flight_seats, one name,
  ≤ 9 checked first, booking-held, payment gap accepted), BR-BOOK-09
Step 2: 5 migrations on shaped dev data; the contract refused twice-broken data, fixed by hand
Step 3: booking reference (crypto, unambiguous alphabet), create → created | reference-taken,
  retry loop in the use case
Step 4: holdSeats (auto SKIP LOCKED / chosen in lock order), half-commit test, contract +7
Step 5: passengers body + validation order, booking-held contract + consumer, by-reference
Step 6: race tests A–D (+ controls, 98/100 natural deadlocks), mutations (ORDER BY survivor
  explained by EXPLAIN), e2e, Postman, README, ADR-004 addendum, learnings note
```

## Previous day (Day 47) recap

```text
Each flight owns a copy of its aircraft's seats; availableSeats counted on read; booking
claims the lowest free seat with SKIP LOCKED; public seat map.
```

## Next

Day 48B — Phase D step 5, part 2: the hold expiry job (`HELD → EXPIRED` after
`holdExpiresAt`, releasing every seat), US-SEAT-02, and the race between expiry and a
concurrent cancel (and later payment). Per
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).
Open items carried (see DAY-48A "Not today"): BR-BOOK-03 pricing, removing the
`booking-created` contract once its queue is empty, the `SKIP LOCKED` multi-seat edge.

# CURRENT PROGRESS

**Last completed day:** Day 44
**Current day:** Day 44 — booking ownership (phase D step 1)
**Status:** ✅ Complete — unit 186/186, integration 52/52, end-to-end verified (Postman + psql).
Every booking has an owner (`owner_account_id`, expand → contract migrations); ownership is
enforced inside `BookingRepository` queries via `BookingAccessScope`, including `cancel()`'s
follow-up read. Another account's booking answers `404` exactly like a missing one. New routes
`GET /api/bookings` and `GET /api/bookings/:id`; create/cancel need `role=user`. Audit actors are
real accounts (flight and booking writes). Unit tests 159 → 186.

## Day 44 delivered

```text
Step 0: BR-PAY-06 (pay after sales close while the hold is valid); 24-hour
  rule confirmed to apply to CONFIRMED only
Step 1: AddBookingOwner (nullable + owner/created_at index) and
  RequireBookingOwner (refuses on NULLs, never deletes)
Step 2–3: port takes a scope; fake + Postgres adapter + 8 contract cases;
  shown to catch an unscoped follow-up read
Step 4: use cases take actor/scope explicitly; GetBooking, ListBookings;
  shared pagination.ts; malformed ids → not-found; account audit actors
Step 5: routes + one toBookingAccessScope helper; 15 HTTP tests incl. BOLA
Step 6: Postman (bob/carol + BOLA folder), README, domain-model, learnings
```

## Previous day (Day 43) recap

```text
Product scope (22 stories, Won't) and domain model (aggregates, lifecycles,
BR-* rules, permissions, phase-D order) written before any phase-D code.
```

## Next

Day 45 — Phase D step 2: airports + aircraft with seat layouts (US-REF-01/02/03, BR-REF-*), per
[`docs/product/domain-model.md`](../../docs/product/domain-model.md#phase-d-order).

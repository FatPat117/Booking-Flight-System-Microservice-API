# Day 44 — Session Notes

**Date:** 2026-10-09
**Theme:** Booking ownership — phase D step 1 (BR-AUTH-01/02/03, US-BOOK-02/03)
**Status:** ✅ Complete — unit 186/186, integration 52/52, six end-to-end scenarios verified.

## Why

```text
Until today POST .../bookings and DELETE /api/bookings/:id needed no token and
bookings had no owner: anyone holding a booking id could cancel it. That is
BOLA (OWASP API #1): role checks existed (Day 34), object checks did not.
Middleware cannot do the object check — it doesn't know who owns booking abc
— so it has to live where the data is read.
```

## Step 0 — Two rules missing from Day 43

```text
BR-PAY-06 added: a still-valid hold can be paid after sales close (CLOSED),
  until it expires; closing stops new holds only. Bounded risk: holds last
  ≤ 15 min, sales close 1 h before departure, so every payable hold ends
  ≥ 45 min before take-off. Linked from the OPEN→CLOSED and HELD→CONFIRMED
  lifecycle rows.
24-hour rule: checked, no change — BR-BOOK-06 already applies to CONFIRMED
  only and HELD→CANCELLED has no time condition. Rationale written down
  (nothing paid; releasing early only helps other customers).
```

## Decisions

```text
Name: ownerAccountId / owner_account_id (Day 43 glossary: Account), not
  ownerUserId. JWT sub -> accountId is mapped in exactly one place
  (auth/booking-access.ts).
BookingAccessScope = { kind: "owner"; accountId } | { kind: "admin" } — a
  union, so "no owner filter" can only be asked for by name, never by
  passing undefined.
findPage(scope, page) serves both "my bookings" and the admin list.
Old data: option (b) — contract migration refuses (RAISE EXCEPTION with the
  count and what to do) if any owner is NULL; it never deletes. Dev DB is
  reset instead. TypeORM runs pending migrations in one transaction, so the
  failure also rolls back the expand step.
No FK to accounts: identity_db is a different database by design (Day
  36/42). Deleting an account doesn't touch its bookings — an event later if
  it ever matters.
Index idx_bookings_owner_created (owner_account_id, created_at DESC, id DESC)
  shaped to the one real query — the opposite of Day 38's "no query, no
  index". The admin "all bookings" list has no dedicated index (dev scale).
FLIGHT_CREATED actor fixed too (user's choice): AuditActor is now only
  { type: "account", id: sub }; legacy rows keep admin_api_key /
  passenger-anonymous as written (append-only log, loose CHECK from Day 38 →
  no migration).
BookingCreatedEvent unchanged (user's choice): no consumer needs the owner
  yet; it gets added at phase D step 9 (flight-cancellation cascade).
Malformed ids (user's choice): booking routes answer 404, not Postgres
  22P02 → 500. isUuid() in types.ts; use cases return not-found before any
  query.
Admin create/cancel booking → 403 (permission matrix: admins don't act on
  someone's behalf; cancel only through flight cancellation). 403 is fine
  there: it is a function-level refusal and reveals nothing about a booking.
```

## What changed

```text
Migrations: AddBookingOwner (expand: nullable column + index) and
  RequireBookingOwner (contract: guarded SET NOT NULL).
Port: Booking.ownerAccountId; findById(id, scope), findPage(scope, page),
  cancel(id, scope). Doc comment states the rule: every query in a flow is
  scoped, including the follow-up read that picks an error.
Adapter: scopeFilter() for reads; cancel's UPDATE adds an explicit
  owner_account_id condition; mapBooking().
Use cases: CreateBooking(flightId, input, actor), CancelBooking(id, scope,
  actor), CreateFlight(input, actor); new GetBooking, ListBookings. No use
  case reads the request context (grep-verified).
pagination.ts: parse/format moved out of list-flights.ts (list-flights tests
  unchanged, 11/11).
Routes: POST .../bookings (user), GET /api/bookings, GET /api/bookings/:id,
  DELETE /api/bookings/:id (user). Location now /api/bookings/:id and
  resolvable. One shared BOOKING_NOT_FOUND body.
Postman: bob = user A (userAccessToken), carol = user B (userBAccessToken);
  JWT on all booking requests; GET list/one; "Day 44 — Booking ownership
  (BOLA)" folder with status/code assertions.
Docs: README (auth table, object-level authorization paragraph, audit,
  flow, limitations), domain-model (Existing column, gap table rows),
  learnings/object-level-authorization.md.
```

## Proof the tests bite

```text
Fake: scoped "not-found" check moved after the already-cancelled check
  (mimicking an unscoped follow-up read) → only the contract case
  "cancel of another account's already-cancelled booking is not-found, not
  already-cancelled" failed (14/15). Reverted → 15/15.
HTTP: toBookingAccessScope() returning admin for everyone → exactly the 4
  BOLA tests failed (11/15). Reverted → 15/15.
Postgres: `...scopeFilter(scope)` dropped from cancel()'s follow-up
  findOneBy → 2 contract cases failed (13/15): the already-cancelled one
  above, and "cancel of another account's active booking is not-found"
  (the adapter answers already-cancelled for any row the follow-up read
  finds, so an unscoped read leaks even an active booking). Reverted → 15/15.
```

## Test count reconciliation

```text
Unit: 159 before → 186 after (+27, nothing removed):
  contract +8, create-booking +1, cancel-booking +2, get-booking +4 (new),
  list-bookings +3 (new), bookings.api 6 → 15 (+9).
Integration: 44 before (37 direct + 7 contract) → 52 after, 52/52 green
  (+8 contract scope cases). Existing integration tests were only re-wired
  (owner/actor/scope args, account actor) plus one assertion that
  owner_account_id is persisted.
```

## End-to-end (docker-compose)

Run through Postman (A = bob, B = carol, admin = alice), folder
"Day 44 — Booking ownership (BOLA)" plus the Bookings folder.

```text
1. Register/login A and B (+ admin).            ✅ alice promoted + re-logged in
                                                   (first attempt 403: token issued
                                                   before promote still said role=user)
2. A books; GET the Location URL → 200.         ✅ 201 + Location, GET → 200
3. B GET + DELETE A's booking → 404; booking
   still active.                                 ✅ 404 BOOKING_NOT_FOUND both;
                                                   admin GET → 200 afterwards
4. A cancels; B DELETE again → 404 (not 409).   ✅ A 204, B 404, A again 409
5. GET /api/bookings as B → empty.              ✅ 200, none of A's bookings
   Admin POST/DELETE booking → 403; no token
   → 401.                                        ✅
6. audit_logs: account/<sub A> on BOOKING_CREATED
   + BOOKING_CANCELLED, account/<sub admin> on
   FLIGHT_CREATED.                               ✅ psql: FLIGHT_CREATED
                                                   account/add4f392… (alice),
                                                   BOOKING_CREATED + BOOKING_CANCELLED
                                                   account/716197ea… (bob); bookings
                                                   row owner_account_id = bob
```

## Not today

```text
GET /api/flights/:id with a malformed id still 500s (flight routes were out
  of scope; same isUuid fix applies).
No index for the admin "all bookings, newest first" list.
BookingCreatedEvent has no owner (phase D step 9).
Bookings of a deleted Identity account are not cleaned up (no cross-database
  FK; would be an account-deleted event).
```

## DAY 44 SUMMARY

```text
Every booking now has an owner, and ownership is enforced inside the
repository queries through an explicit BookingAccessScope — including the
follow-up read that only chooses an error, which is where a 409 would
otherwise have leaked another account's booking. Another account's booking
is indistinguishable from a missing one (404, same body); role checks
(401/403) stay at the edge. The new required column went in through
expand → contract with a migration that refuses, never deletes. Contract and
HTTP tests were each shown to fail on the exact bug they guard.
```

# Postman

Import these files into Postman (or re-import if you already had an older collection):

1. `Booking-microservices.postman_collection.json`
2. `Booking-microservices.local.postman_environment.json`

Select the **Booking Microservices — Local** environment before sending requests.

## Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `baseUrl` | `http://localhost:3000` | Match `PORT` in `.env` |
| `identityBaseUrl` | `http://localhost:3001` | Identity register/login |
| `accessToken` | empty | Auto-set after Identity login (`role=admin` needed for create flight) |
| `userAccessToken` | empty | Auto-set after login as `bob` (`role=user`) — owner of the bookings you create; also the 403 example on `POST /api/flights` |
| `userBAccessToken` | empty | Auto-set after login as `carol` (`role=user`) — the second account for the Day 44 BOLA folder |
| `flightId` | empty | Auto-set after successful `POST /api/flights` |
| `bookingId` | empty | Auto-set after successful `POST .../bookings` |
| `requestId` | `investigate-001` | Sent as `x-request-id` → becomes Day 29 `correlationId` |
| `day46FlightId`, `day46ScheduledFlightId` | empty | Auto-set by the Day 46 folder: the flight it opens and the one it leaves `SCHEDULED` |

## Auth reminder

`POST /api/flights` uses **Authorization: Bearer {{accessToken}}** with `role=admin` — not an API key.

Since Day 44 every booking route needs a JWT: create and cancel need `role=user` (an admin token gets `403`), `GET /api/bookings` and `GET /api/bookings/:id` accept either role (users see their own, admins see all). Another account's booking answers `404`, exactly like a missing one.

## Start servers (dev)

```bash
docker compose up -d rabbitmq postgres   # RabbitMQ :5672 (UI :15672) + Postgres :5432 (identity_db + booking_db)
npm run dev --workspace=@booking-flight-system/api               # :3000
npm run dev --workspace=@booking-flight-system/identity          # :3001
npm run dev --workspace=@booking-flight-system/flight-notifier
```

`api` and `identity` run their Postgres migrations on startup. Requires a root `.env` (see `.env.example`).

## Suggested flow

1. **Identity** → `POST /api/identity/register` then promote:
   `npm run promote-to-admin --workspace=@booking-flight-system/identity -- your@email.com`
2. **Identity** → `POST /api/identity/login` (saves `accessToken`)
3. **JWT** → `GET /api/whoami` (optional probe; returns `userId`, `email`, `role`)
4. **Flights (Write)** → `POST /api/flights` (saves `flightId`), then `POST /api/flights/:id/open`. Since Day 46 the body names an `aircraftRegistration` instead of `availableSeats` (run the seed first, see step 11), and a new flight is `SCHEDULED`: until it is opened, every booking answers `409 SALES_CLOSED`
5. **Identity** → register + login `bob` and `carol` (saves `userAccessToken`, `userBAccessToken`)
6. **Bookings** → `POST /api/flights/:flightId/bookings` as bob (saves `bookingId`); `GET /api/bookings/:id` follows the `Location`
7. Wait ~5s → check flight-notifier for `booking_created_consumed` + same `correlationId` as `x-request-id`
8. Folder **Day 44 — Booking ownership (BOLA)** → carol and admin are refused without learning whether bob's booking exists
9. **Bookings** → `DELETE /api/bookings/:id` twice as bob → `204` then `409`
10. Folder **Day 29 — Correlation investigate** → auto-generates a fresh `requestId` for log grep
11. Folder **Day 45 — Reference data** → register an airport and an aircraft as admin; run it on a fresh database (the first requests answer `409` on a second run). `npm run seed:reference --workspace=@booking-flight-system/api` adds 25 airports (12 in Vietnam, 13 abroad incl. DST zones) and 8 aircraft (A320neo to A350, plus an ATR 72) and can run any number of times
12. Folder **Day 46 — Flight lifecycle** → needs the seed, alice's `accessToken` and bob's `userAccessToken`; run top to bottom on a database without VN461/VN462 on 2026-11-20

## Coverage (through Day 46)

- Health: `/live`, `/health`, `/ready` (booking api `:3000`; `/ready` checks Postgres)
- Flights / bookings / cancel / correlation probes
- **Identity** (`identityBaseUrl` `:3001`): `/live`, register (+ validation / duplicate), JWT login with `role`
- **Admin write**: `POST /api/flights` with admin JWT; `GET /api/whoami`
- **Error examples**: 401 (no token), 403 (non-admin: register + login `bob`, **don't** promote), 404 (flight / booking / route), 409, 422
- **Booking ownership (Day 44)**: my bookings list, get by id, BOLA checks (404 for another account, 403 for admin create/cancel, 401 without token)
- **Reference data (Day 45)**: `POST /api/airports` (code normalized, 409, IANA time zone 422, 403 for users), public `GET /api/airports`, `POST /api/aircraft` (seat counts, overlapping cabins 422 naming the seat, size limit 422); `GET /api/flights/not-a-uuid` → 404
- **Flight lifecycle (Day 46)**: create with IATA codes + `aircraftRegistration` (seats from the aircraft, `SCHEDULED`), `409 AIRCRAFT_UNAVAILABLE` inside arrival + 45 min and `201` exactly at it, `422 UNSUPPORTED_FIELD` for `availableSeats`, `422` unknown airports/aircraft at once, `POST /api/flights/:id/open` (`200`, `409 INVALID_FLIGHT_STATUS`, `403` for users), booking a `SCHEDULED` flight → `409 SALES_CLOSED`

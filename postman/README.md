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
| `flightId` | empty | Auto-set after successful `POST /api/flights` |
| `bookingId` | empty | Auto-set after successful `POST .../bookings` |
| `requestId` | `investigate-001` | Sent as `x-request-id` → becomes Day 29 `correlationId` |

## Auth reminder

`POST /api/flights` uses **Authorization: Bearer {{accessToken}}** with `role=admin` — not an API key.

## Start servers (dev)

```bash
docker compose up rabbitmq postgres   # terminal 1
npm run dev --workspace=@booking-flight-system/api
npm run dev --workspace=@booking-flight-system/flight-notifier
npm run dev --workspace=@booking-flight-system/identity
```

## Suggested flow

1. **Identity** → `POST /api/identity/register` then promote:
   `npm run promote-to-admin --workspace=@booking-flight-system/identity -- your@email.com`
2. **Identity** → `POST /api/identity/login` (saves `accessToken`)
3. **JWT** → `GET /api/whoami` (optional probe)
4. **Flights (Write)** → `POST /api/flights` (saves `flightId`)
5. **Bookings** → `POST /api/flights/:flightId/bookings` (saves `bookingId`)
6. Wait ~5s → check flight-notifier for `booking_created_consumed` + same `correlationId` as `x-request-id`
7. **Bookings** → `DELETE /api/bookings/:id` twice → `204` then `409`
8. Folder **Day 29 — Correlation investigate** → auto-generates a fresh `requestId` for log grep

## Coverage (through Day 34)

- Health: `/live`, `/health`, `/ready` (booking api `:3000`)
- Flights / bookings / cancel / correlation probes
- **Identity** (`identityBaseUrl` `:3001`): register + JWT login with `role`
- **Admin write**: `POST /api/flights` with admin JWT; `GET /api/whoami`

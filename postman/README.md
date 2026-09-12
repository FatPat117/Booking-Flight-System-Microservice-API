# Postman

Import these files into Postman (or re-import if you already had the Day 15 collection):

1. `Booking-microservices.postman_collection.json`
2. `Booking-microservices.local.postman_environment.json`

Select the **Booking Microservices — Local** environment before sending requests.

## Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `baseUrl` | `http://localhost:3000` | Match `PORT` in `.env` |
| `adminApiKey` | `local-dev-admin-key-2026` | Must match `.env` `ADMIN_API_KEY` |
| `flightId` | empty | Auto-set after successful `POST /api/flights` |
| `bookingId` | empty | Auto-set after successful `POST .../bookings` |
| `requestId` | `investigate-001` | Sent as `x-request-id` → becomes Day 29 `correlationId` |

## Auth reminder

`POST /api/flights` uses **Authorization: Bearer {{adminApiKey}}** — not `x-api-key`.

## Start servers (dev)

```bash
docker compose up rabbitmq postgres   # terminal 1
npm run dev --workspace=@booking-flight-system/api
npm run dev --workspace=@booking-flight-system/flight-notifier
npm run dev --workspace=@booking-flight-system/identity
```

## Suggested flow

1. **Identity** → `POST /api/identity/register` then `POST /api/identity/login` (saves `accessToken`; paste into jwt.io)
2. **Flights (Write)** → `POST /api/flights` (saves `flightId`) — still uses `ADMIN_API_KEY` until Day 33
3. **Bookings** → `POST /api/flights/:flightId/bookings` (saves `bookingId`)
4. Wait ~5s → check flight-notifier for `booking_created_consumed` + same `correlationId` as `x-request-id`
5. **Bookings** → `DELETE /api/bookings/:id` twice → `204` then `409`
6. Folder **Day 29 — Correlation investigate** → auto-generates a fresh `requestId` for log grep

## Coverage (through Day 32)

- Health: `/live`, `/health`, `/ready` (booking api `:3000`)
- Flights / bookings / cancel / correlation probes
- **Identity** (`identityBaseUrl` `:3001`): register + JWT login (`accessToken` / `expiresIn`)

# Use case trong project — bảng tra nhanh

Mọi use case là một factory `createX(deps)` trả về hàm async. Kết quả là discriminated union
`{ outcome: … }`; route trong `api/src/app.ts` chỉ dịch `outcome` → HTTP.

Mẫu chung của một use case **ghi**:

```text
validate input (ngoài transaction)  →  transactionRunner.run(
    repository ghi (điều kiện nằm trong câu SQL)
    auditRecorder.record(...)          ← cùng transaction
    outboxRepository.enqueue(...)      ← cùng transaction (nếu có event)
)
```

## Tất cả endpoint

| Method & path | Quyền | Use case | Thành công | Lỗi chính | Chi tiết |
|---|---|---|---|---|---|
| `GET /live`, `/health` | public | — | 200 | — | [background](./background-jobs-va-consumer.md) |
| `GET /ready` | public | HealthChecks | 200 | 503 | [background](./background-jobs-va-consumer.md) |
| `POST /api/flights` | admin | CreateFlight | 201 + Location | 422, 409 `FLIGHT_ALREADY_EXISTS` / `AIRCRAFT_UNAVAILABLE` | [flights](./flights.md) |
| `POST /api/flights/:id/open` | admin | OpenFlight | 200 | 404, 409 `INVALID_FLIGHT_STATUS` / `FLIGHT_STATUS_CHANGED` | [flights](./flights.md) |
| `GET /api/flights` | public | ListFlights | 200 | 422 | [flights](./flights.md) |
| `GET /api/flights/:id` | public | GetFlight | 200 | 404 | [flights](./flights.md) |
| `GET /api/flights/:id/seats` | public | GetFlightSeatMap | 200 | 404 | [flights](./flights.md) |
| `POST /api/flights/:id/bookings` | user | CreateBooking | 201 + Location | 422, 404, 409 `NOT_ENOUGH_SEATS` / `SEATS_UNAVAILABLE` / `SALES_CLOSED` | [bookings](./bookings.md) |
| `GET /api/bookings` | user/admin | ListBookings | 200 | 422 | [bookings](./bookings.md) |
| `GET /api/bookings/:id` | user/admin | GetBooking | 200 | 404 | [bookings](./bookings.md) |
| `GET /api/bookings/by-reference/:ref` | user/admin | GetBookingByReference | 200 | 404 | [bookings](./bookings.md) |
| `DELETE /api/bookings/:id` | user (chủ) | CancelBooking | 204 | 404, 409 `BOOKING_ALREADY_CANCELLED` | [bookings](./bookings.md) |
| `POST /api/airports` | admin | RegisterAirport | 201 | 422, 409 `AIRPORT_ALREADY_EXISTS` | [reference-data](./reference-data.md) |
| `GET /api/airports` | public | ListAirports | 200 | 422 | [reference-data](./reference-data.md) |
| `POST /api/aircraft` | admin | RegisterAircraft | 201 | 422, 409 `AIRCRAFT_ALREADY_EXISTS` | [reference-data](./reference-data.md) |
| `GET /api/whoami` | JWT bất kỳ | — | 200 | 401 | [identity](./identity.md) |
| `GET /live` (identity :3001) | public | — | 200 | — | [identity](./identity.md) |
| `POST /api/identity/register` | public (identity :3001) | RegisterUser | 201 | 422, 409 `EMAIL_ALREADY_REGISTERED` | [identity](./identity.md) |
| `POST /api/identity/login` | public (identity :3001) | LoginUser | 200 | 422, 401 `INVALID_CREDENTIALS` | [identity](./identity.md) |

Lỗi chung cho mọi route: `400 MALFORMED_JSON`, `401` (thiếu/sai/hết hạn token), `403 FORBIDDEN`
(sai role), `404 ROUTE_NOT_FOUND`, `500 INTERNAL_SERVER_ERROR` (không lộ chi tiết). Body lỗi luôn là
`{ error: { code, message, details? } }`.

## Audit và event

| Use case | Audit action | Event (outbox → queue) |
|---|---|---|
| CreateFlight | `FLIGHT_CREATED` | `flight-created` |
| OpenFlight | `FLIGHT_OPENED` | — |
| CreateBooking | `BOOKING_CREATED` | `booking-held` (trước Day 48A: `booking-created`) |
| CancelBooking | `BOOKING_CANCELLED` | `booking-cancelled` (chưa có consumer) |
| RegisterAirport | `AIRPORT_REGISTERED` | — |
| RegisterAircraft | `AIRCRAFT_REGISTERED` | — |

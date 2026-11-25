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
| `POST /api/flights/:id/cancel` | admin | CancelFlight (Day 52) | 200 `{ flight, remainingBookings }` (gọi lại vẫn 200) | 404, 403 user, 409 `INVALID_FLIGHT_STATUS` (`DEPARTED`) / `FLIGHT_STATUS_CHANGED` | [flights](./flights.md) |
| `GET /api/flights` | public | ListFlights | 200 | 422 | [flights](./flights.md) |
| `GET /api/flights/search` | public | SearchFlights (Day 51) | 200 `{ items, page }` | 422, 400 `INVALID_CURSOR` | [flights](./flights.md) |
| `GET /api/flights/:id` | public | GetFlight (Day 51: + availability theo hạng, giờ địa phương) | 200 | 404 | [flights](./flights.md) |
| `GET /api/flights/:id/seats` | public | GetFlightSeatMap | 200 | 404 | [flights](./flights.md) |
| `POST /api/flights/:id/bookings` | user | CreateBooking | 201 + Location | 422, 404, 409 `NOT_ENOUGH_SEATS`, 422 `FARE_CLASS_NOT_ON_AIRCRAFT` (Day 51) / `SEATS_UNAVAILABLE` / `SALES_CLOSED` | [bookings](./bookings.md) |
| `GET /api/bookings` | user/admin | ListBookings | 200 | 422 | [bookings](./bookings.md) |
| `GET /api/bookings/:id` | user/admin | GetBooking | 200 | 404 | [bookings](./bookings.md) |
| `GET /api/bookings/by-reference/:ref` | user/admin | GetBookingByReference | 200 | 404 | [bookings](./bookings.md) |
| `DELETE /api/bookings/:id` | user (chủ) | CancelBooking | 200 `{ booking, refund }` | 404, 409 `BOOKING_ALREADY_CANCELLED` / `BOOKING_EXPIRED` / `CANCELLATION_WINDOW_CLOSED` | [bookings](./bookings.md) |
| `PUT /api/bookings/:id/passengers/:position/seat` | user (chủ) | ChangeSeat | 200 | 404, 409 `SEAT_UNAVAILABLE` / `FARE_CLASS_MISMATCH` / `BOOKING_NOT_CHANGEABLE` / `SALES_CLOSED`, 422 | [bookings](./bookings.md) |
| `POST /api/bookings/:id/payments` | user (chủ) | PayForBooking | 201 (phát lại: + `Idempotent-Replayed`) | 402 `PAYMENT_DECLINED`; 409 `BOOKING_NOT_PAYABLE` / `IDEMPOTENCY_KEY_IN_PROGRESS` / `PAYMENT_IN_PROGRESS`; 422 `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_REUSED` / `PAYMENT_AMOUNT_MISMATCH`; 404; 403 admin | [bookings](./bookings.md) |
| (job 60 s, không route) | system | ExpireHolds | — | lô lỗi → rollback, log `job_failed` | [bookings](./bookings.md), [background](./background-jobs-va-consumer.md) |
| (job 30 s, không route) | system | CascadeFlightCancellations (Day 52) | — | booking claim được mà không huỷ được → throw (bug) | [bookings](./bookings.md), [background](./background-jobs-va-consumer.md) |
| `POST /api/airports` | admin | RegisterAirport | 201 | 422, 409 `AIRPORT_ALREADY_EXISTS` | [reference-data](./reference-data.md) |
| `GET /api/airports` | public | ListAirports | 200 | 422 | [reference-data](./reference-data.md) |
| `POST /api/aircraft` | admin | RegisterAircraft | 201 | 422, 409 `AIRCRAFT_ALREADY_EXISTS` | [reference-data](./reference-data.md) |
| `GET /api/admin/flights/:id/manifest` | admin | GetFlightManifest (Day 53) | 200 (đọc trong `REPEATABLE READ READ ONLY`, ghi audit việc xem) | 401, 403, 404 `FLIGHT_NOT_FOUND`, 500 nếu không ghi được audit | [admin-reports](./admin-reports.md) |
| `GET /api/admin/reports/load-factor` | admin | GetLoadFactor (Day 53) | 200 `{ items, page }` | 401, 403, 422, 400 `INVALID_CURSOR` | [admin-reports](./admin-reports.md) |
| `GET /api/admin/audit-logs` | admin | QueryAuditLog (Day 53) | 200 `{ items, page }` | 401, 403, 422 `FILTER_REQUIRED`, 400 `INVALID_CURSOR` | [admin-reports](./admin-reports.md) |
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
| CreateFlight | `FLIGHT_CREATED` (có `fares`, Day 49A) | `flight-created` (có `fares`; `priceInCents` deprecated) |
| OpenFlight | `FLIGHT_OPENED` | — |
| CancelFlight (Day 52) | `FLIGHT_CANCELLED` (metadata `previousStatus` hiệu lực, vd `CLOSED`); gọi lại không ghi thêm | — (không có `flight-cancelled`; mỗi booking có event riêng) |
| CascadeFlightCancellations (job, Day 52) | `BOOKING_CANCELLED` + `PAYMENT_REFUND_PENDING` nếu đã trả, actor `system/flight-cancellation`, `reason: AIRLINE` | `booking-cancelled` với `reason: "AIRLINE"` |
| CreateBooking | `BOOKING_CREATED` (có `totalVnd`, Day 49A) | `booking-held` (trước Day 48A: `booking-created`; Day 49A thêm giá + `total`) |
| CancelBooking | `BOOKING_CANCELLED` (`reason: CUSTOMER` từ Day 52) | `booking-cancelled` (consumer từ Day 50; `reason` tuỳ chọn từ Day 52) |
| ExpireHolds (job) | `BOOKING_EXPIRED`, actor `system/booking-hold-expiry` | `booking-expired` |
| PayForBooking | `BOOKING_CONFIRMED` (target booking); `PAYMENT_FAILED`, `PAYMENT_REFUND_PENDING` (target payment); `PAYMENT_REFUNDED` actor `system/payment-refund` | `booking-confirmed` (chỉ khi thành công) |
| RegisterAirport | `AIRPORT_REGISTERED` | — |
| RegisterAircraft | `AIRCRAFT_REGISTERED` | — |
| GetFlightManifest (Day 53, chỉ đọc) | `FLIGHT_MANIFEST_VIEWED` (metadata `passengerCount`, không tên), transaction riêng sau khi đọc | — |

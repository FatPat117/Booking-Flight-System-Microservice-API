# Use case: chuyến bay

## CreateFlight — `POST /api/flights` (admin)

**Code:** `api/src/flights/create-flight.ts`, `flight-validation.ts`, `postgres/postgres-flight-repository.ts`

**Input:**
```json
{ "flightNumber": "VN461", "origin": "SGN", "destination": "HAN", "aircraftRegistration": "VN-A321",
  "departureAt": "2026-11-20T08:00:00+07:00", "arrivalAt": "2026-11-20T10:00:00+07:00",
  "priceInCents": 1500000, "currency": "VND" }
```

**Luồng:**
1. Validate hình dạng: thiếu field, chuỗi rỗng, mã sân bay, datetime hợp lệ, giá nguyên dương,
   currency, đến sau đi (`ARRIVAL_BEFORE_DEPARTURE`), đi ≠ đến (`ORIGIN_EQUALS_DESTINATION`).
   `availableSeats` → `UNSUPPORTED_FIELD` (số ghế lấy từ máy bay).
2. Tra **song song** origin, destination, aircraft; báo **mọi** tham chiếu không tồn tại cùng lúc
   (`UNKNOWN_AIRPORT`, `UNKNOWN_AIRCRAFT`).
3. Trong transaction:
   - insert flight `SCHEDULED`;
   - **một câu SQL copy layout ghế** của máy bay vào `flight_seats` (tất cả `AVAILABLE`) — layout
     không đi qua TypeScript;
   - audit `FLIGHT_CREATED`, outbox `flight-created`.

**Outcome → HTTP:**
| Outcome | HTTP |
|---|---|
| `created` | 201 + `Location` |
| `validation_failed` | 422 `VALIDATION_FAILED` |
| `duplicate` (`UQ` flight number + giờ đi) | 409 `FLIGHT_ALREADY_EXISTS` |
| `aircraft-unavailable` (exclusion `23P01` **hoặc** deadlock `40P01`) | 409 `AIRCRAFT_UNAVAILABLE` |

**Xử lý hay:**
- Lịch máy bay chống chồng giờ bằng **exclusion constraint** (khoảng `[đi, đến + 45 phút)`).
  Insert đồng thời ra `40P01` → map sang 409, an toàn vì insert flight là câu ghi đầu tiên.
- FK sai (race: sân bay bị xoá giữa lúc tra và lúc ghi) → `reference-not-found` → 422.
- Ghế được **copy** (không tham chiếu) → sửa layout máy bay sau này không ảnh hưởng chuyến đã bán.

## OpenFlight — `POST /api/flights/:id/open` (admin)

**Code:** `api/src/flights/open-flight.ts`, `flight-lifecycle.ts`

**Luồng:**
1. id sai định dạng / không có → `not-found` (404).
2. Tính trạng thái **hiệu lực** (`effectiveFlightStatus`: OPEN mà còn ≤ 1 giờ là CLOSED).
3. `transitionFlight(current, "OPEN")` theo bảng lifecycle → không hợp lệ thì
   `invalid-status` với lý do `NOT_ALLOWED` hoặc `DEPARTURE_TOO_SOON` → 409 `INVALID_FLIGHT_STATUS`.
4. Transaction: `changeStatus(id, expected, "OPEN")` = compare-and-set
   `WHERE id = :id AND status = :expected`. Thua → `status-changed` → 409 `FLIGHT_STATUS_CHANGED`.
5. Audit `FLIGHT_OPENED` (metadata `previousStatus`). Không có event.

**Xử lý hay:** chỉ lưu `SCHEDULED/OPEN/CANCELLED`; `CLOSED/DEPARTED` dẫn xuất từ đồng hồ (ADR-008)
→ không cần job, không race với job. Mở bán là **command** (`POST …/open`), không phải PATCH
`status`, vì người dùng chỉ được đặt đúng một trạng thái.

## ListFlights — `GET /api/flights?page=&pageSize=` (public)

**Code:** `api/src/flights/list-flights.ts`, `api/src/pagination.ts`

- `page` mặc định 1, `pageSize` mặc định 20, tối đa 100; sai → 422 `INVALID_PAGE` / `INVALID_PAGE_SIZE`.
- Sắp `departure_at, id` (id làm tie-breaker → trang ổn định). Trang vượt quá → 200 với `items: []`.
- `availableSeats` **tính khi đọc** bằng scalar subquery trên partial index (chuyến hết ghế hiện 0).
- Trả `{ items, pagination: { page, pageSize, totalItems, totalPages } }`.

**Giới hạn đã đo:** OFFSET sâu chậm (trang 100 / 2000 chuyến: 52 ms vs 1,4 ms trang đầu).

## GetFlight — `GET /api/flights/:id` (public)

id sai định dạng hoặc không có → 404 `FLIGHT_NOT_FOUND`. Trả `FlightView` với `status` hiệu lực,
`origin/destination` là mã IATA, kèm `originAirportId`, `destinationAirportId`, `aircraftId`.

## GetFlightSeatMap — `GET /api/flights/:id/seats` (public)

**Code:** `api/src/flights/get-flight-seat-map.ts`

```json
{ "flightId": "…", "rows": [ { "row": 1, "seats": [ { "code": "1A", "fareClass": "BUSINESS", "status": "HELD" } ] } ] }
```

- Trạng thái ghế: `AVAILABLE` / `HELD` / `BOOKED`.
- **Không** có booking id, chủ sở hữu, tên khách — repository không select `booking_id`; test
  allow-list mọi key ở mọi độ sâu.
- Là ảnh chụp: ghế hiện `AVAILABLE` có thể bị giữ ngay sau đó; câu giữ ghế mới là nơi quyết định.

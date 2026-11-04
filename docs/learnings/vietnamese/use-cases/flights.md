# Use case: chuyến bay

## CreateFlight — `POST /api/flights` (admin)

**Code:** `api/src/flights/create-flight.ts`, `flight-validation.ts`, `postgres/postgres-flight-repository.ts`

**Input:**
```json
{ "flightNumber": "VN461", "origin": "SGN", "destination": "HAN", "aircraftRegistration": "VN-A321",
  "departureAt": "2026-11-20T08:00:00+07:00", "arrivalAt": "2026-11-20T10:00:00+07:00",
  "fares": { "ECONOMY": 1500000, "BUSINESS": 4200000 } }
```
Giá là **số đồng nguyên** (không ×100), một giá mỗi hạng ghế, không gửi `currency` (chỉ VND).
Response trả dạng `Money`: `"fares": { "ECONOMY": { "amount": 1500000, "currency": "VND" }, … }`.

**Luồng:**
1. Validate hình dạng: thiếu field, chuỗi rỗng, mã sân bay, datetime hợp lệ, đến sau đi
   (`ARRIVAL_BEFORE_DEPARTURE`), đi ≠ đến (`ORIGIN_EQUALS_DESTINATION`).
   `fares` không phải object → `INVALID_FARES`; hạng lạ → `INVALID_FARE_CLASS`; giá không phải số
   nguyên dương an toàn (kể cả gửi object `{amount, currency}`) → `INVALID_FARE`.
   `availableSeats` (Day 46), `priceInCents`, `currency` (Day 49A) → `UNSUPPORTED_FIELD`.
2. Tra **song song** origin, destination, aircraft; báo **mọi** tham chiếu không tồn tại cùng lúc
   (`UNKNOWN_AIRPORT`, `UNKNOWN_AIRCRAFT`) **cùng với** lỗi giá theo máy bay (BR-FLT-09):
   hạng có ghế mà thiếu giá → `MISSING_FARE`; giá cho hạng máy bay không có → `FARE_CLASS_NOT_ON_AIRCRAFT`.
3. Trong transaction:
   - insert flight `SCHEDULED`;
   - **một câu SQL copy layout ghế** của máy bay vào `flight_seats` (tất cả `AVAILABLE`) — layout
     không đi qua TypeScript;
   - **một câu `INSERT … unnest`** ghi giá vào `flight_fares` (Day 49A);
   - audit `FLIGHT_CREATED` (có `fares: "ECONOMY:1500000,BUSINESS:4200000"`), outbox `flight-created`
     (có `fares`; vẫn gửi `priceInCents` = giá ECONOMY và `currency: "VND"`, đã deprecated).

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
- BR-FLT-09 do **ứng dụng** giữ: DB không khai báo được "mỗi hạng ghế phải có một dòng giá". Chưa
  có endpoint đổi giá (chỉ psql); endpoint sau này phải giữ luật này và đi qua `UPDATE flight_fares`.

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

**Giới hạn đã đo:** OFFSET sâu chậm (trang 100 / 2000 chuyến: 52 ms vs 1,4 ms trang đầu). Day 51 giữ nguyên OFFSET cho list này (màn hình admin, cần nhảy trang và `totalItems`); khách tìm chuyến dùng `SearchFlights` bên dưới.

## SearchFlights — `GET /api/flights/search` (public, Day 51)

**Code:** `api/src/flights/search-flights.ts`, `flight-search-validation.ts`, `search-cursor.ts`,
`postgres/flight-search-sql.ts`, `postgres/postgres-flight-search.ts` (port đọc `FlightSearch`)

```text
?origin=SGN&destination=HAN&departureDateFrom=2026-12-01&departureDateTo=2026-12-03
 &passengers=2&sort=departure|price&limit=20&cursor=…
```

- **Ngày theo giờ địa phương của sân bay đi**, cả hai đầu tính vào, tối đa 7 ngày; `To` mặc định = `From`.
- Khớp khi **một hạng** còn ≥ N ghế trống (N = 1–9). `lowestFare` = hạng rẻ nhất **còn đủ chỗ**;
  `availability` liệt kê mọi hạng, rẻ trước, hạng hết chỗ hiện 0.
- Chỉ chuyến **đang bán** (cùng đoạn SQL `onSaleSql` với câu giữ ghế).
- Mỗi kết quả có `departureLocal`, `arrivalLocal` (ISO kèm offset) và `arrivalDayOffset` (`+1` khi qua nửa đêm).
- Trả `{ items, page: { hasNextPage, nextCursor } }` — **keyset**, không có `total`.
- Một câu SQL mỗi trang (đã ghim), dùng `idx_flights_route_departure`.

| Outcome | HTTP |
|---|---|
| `success` (kể cả rỗng, kể cả mã sân bay không tồn tại) | 200 |
| `validation_failed` (`MISSING_FIELD`, `INVALID_AIRPORT_CODE`, `ORIGIN_EQUALS_DESTINATION`, `INVALID_DATE`, `INVALID_DATE_RANGE`, `DATE_RANGE_TOO_LONG`, `INVALID_PASSENGER_COUNT`, `INVALID_SORT`, `INVALID_LIMIT`; tham số lặp → mảng → sai) | 422 `VALIDATION_FAILED`, báo mọi lỗi một lần |
| `invalid_cursor` (không giải mã được, hỏng, hoặc của câu tìm khác) | 400 `INVALID_CURSOR` |

Tham số sai thắng cursor sai (cursor chỉ đánh giá được khi câu tìm hợp lệ). Kết quả là **ảnh chụp**,
không phải lời hứa: câu giữ ghế mới quyết định.

## GetFlight — `GET /api/flights/:id` (public)

id sai định dạng hoặc không có → 404 `FLIGHT_NOT_FOUND`. Trả `FlightView` với `status` hiệu lực,
`origin/destination` là mã IATA, kèm `originAirportId`, `destinationAirportId`, `aircraftId`, và
`fares` (Day 49A; danh sách đọc giá của cả trang bằng **một** query).

**Day 51 (US-FLT-05):** đọc qua `FlightSearch.findDetails` — **một** câu SQL (trước đây 4) — và thêm
`availability` (ghế trống + giá từng hạng, khớp sơ đồ ghế), `departureLocal`, `arrivalLocal`,
`arrivalDayOffset`. Mọi trường cũ giữ nguyên.

## GetFlightSeatMap — `GET /api/flights/:id/seats` (public)

**Code:** `api/src/flights/get-flight-seat-map.ts`

```json
{ "flightId": "…", "fares": { "ECONOMY": { "amount": 1500000, "currency": "VND" }, "BUSINESS": { … } },
  "rows": [ { "row": 1, "seats": [ { "code": "1A", "fareClass": "BUSINESS", "status": "HELD" } ] } ] }
```

- `fares` **một lần** ở đầu (Day 49A), không gắn vào từng ghế: giá ghế = giá hạng của nó.

- Trạng thái ghế: `AVAILABLE` / `HELD` / `BOOKED`.
- **Không** có booking id, chủ sở hữu, tên khách — repository không select `booking_id`; test
  allow-list mọi key ở mọi độ sâu.
- Là ảnh chụp: ghế hiện `AVAILABLE` có thể bị giữ ngay sau đó; câu giữ ghế mới là nơi quyết định.

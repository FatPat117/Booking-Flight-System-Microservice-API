# Use case: dữ liệu tham chiếu (sân bay, máy bay)

## RegisterAirport — `POST /api/airports` (admin)

**Code:** `api/src/airports/register-airport.ts`, `airport-validation.ts`

```json
{ "code": "dad", "name": "Da Nang International", "city": "Da Nang", "timeZone": "Asia/Ho_Chi_Minh" }
```

- Mã chuẩn hoá chữ hoa trước khi lưu → `dad` và `DAD` trùng nhau → 409 `AIRPORT_ALREADY_EXISTS`
  (`UQ_airports_code`, map theo tên constraint).
- `timeZone` phải là tên IANA, không phải offset (`+07:00` → 422); `Etc/*` bị từ chối (là offset
  trá hình, dấu ngược); `UTC` được phép. Chỉ kiểm khi ghi, lưu nguyên giá trị.
- Khoá chính là uuid, mã IATA chỉ là `UNIQUE` — vì mã có thể bị cấp lại.
- Audit `AIRPORT_REGISTERED`, không có event (chưa ai consume).

**Bẫy đã gặp (Day 45):** `Intl` của Node 22 đổi `Asia/Ho_Chi_Minh` thành `Asia/Saigon`, và
`DateTimeFormat` chấp nhận cả `"+07:00"`, `"EST"`. → luật: regex Area/Location (hoặc UTC) +
`DateTimeFormat` chấp nhận.

## ListAirports — `GET /api/airports` (public)

Phân trang như flights, sắp theo `code`.

## RegisterAircraft — `POST /api/aircraft` (admin)

**Code:** `api/src/aircraft/register-aircraft.ts`, `aircraft-validation.ts`, `seat-layout.ts` (`expandSeatLayout`)

```json
{ "registration": "VN-A321", "model": "Airbus A321",
  "seatLayout": { "cabins": [
    { "fareClass": "BUSINESS", "fromRow": 1, "toRow": 2, "seatLetters": "ACDF" },
    { "fareClass": "ECONOMY",  "fromRow": 3, "toRow": 30, "seatLetters": "ABCDEF" } ] } }
```

**Validation theo lớp:**
1. Giới hạn kích thước **trước** khi bung layout: 1–10 cabin, hàng 1–99, ≤ 10 chữ `A`–`K`,
   ≤ 900 ghế (tính từ input). Mảng 100.000 cabin → đúng 1 lỗi `INVALID_CABIN_COUNT`, không duyệt.
2. Từng cabin: fare class, khoảng hàng, chữ ghế (không lặp).
3. Cabin chồng nhau → 422 **nêu đích danh ghế** ("seat 12A is listed twice").
4. Bung thành một dòng mỗi ghế, PK `(aircraft_id, row, letter)` — DB chặn ghế trùng.

**Ghi:** máy bay + toàn bộ ghế **nguyên tử** (repository tự mở transaction nếu chưa có). Mutation
bỏ transaction → test rollback (ghế thứ 150 trùng ghế 1) fail.

**Response:** không trả danh sách ghế đã bung, chỉ `seatCount` và `seatsByFareClass`.
Trùng số đăng ký (chuẩn hoá chữ hoa) → 409 `AIRCRAFT_ALREADY_EXISTS`. Audit `AIRCRAFT_REGISTERED`.

## Seed dev

`npm run seed:reference --workspace=@booking-flight-system/api`: 25 sân bay (12 VN, 13 quốc tế có
múi giờ DST), 8 máy bay (68–348 ghế). Idempotent, không ghi audit.

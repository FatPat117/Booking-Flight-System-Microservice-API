# Danh sách migration (đến Day 48B)

Thư mục: `api/src/postgres/migrations/` (database `booking_db`) và
`services/identity/src/migrations/` (database `identity_db`). Tên file = timestamp + tên lớp.

## `booking_db` — 24 migration

| # | Migration | Day | Làm gì | Điểm hay / lý do |
|---|---|---|---|---|
| 1 | `CreateFlights` | 36 | Bảng `flights`, ngày giờ `TIMESTAMPTZ`, CHECK đến sau đi, `UNIQUE (flight_number, departure_at)` | Dịch từ SQLite: TEXT → TIMESTAMPTZ. `duplicate` của repository dựa vào UNIQUE này |
| 2 | `CreateOutbox` | 37 | Bảng `outbox`, payload `jsonb`, partial index `WHERE published_at IS NULL` | Index phục vụ đúng câu poll của relay; nhỏ dần khi publish |
| 3 | `CreateAuditLogs` | 38 | Bảng `audit_logs`, metadata `jsonb` | CHECK cố ý **lỏng** (chỉ `length > 0`) vì danh sách action tăng theo feature; type TypeScript là rào chắn thật. Không index vì chưa có query đọc |
| 4 | `CreateBookings` | 39 | Bảng `bookings`, FK tới flights (NO ACTION), CHECK status `active/cancelled`, `idx_bookings_flight_id` | NO ACTION: chặn xoá thay vì cascade mất lịch sử. Postgres thực thi FK (SQLite trước đó thì không) |
| 5 | `AddBookingOwner` | 44 | Expand: `owner_account_id` nullable + `idx_bookings_owner_created` | **Không FK** sang accounts: khác database. Index khớp đúng query "booking của tôi, mới nhất trước" |
| 6 | `RequireBookingOwner` | 44 | Contract: `NOT NULL` | Từ chối nếu còn booking không chủ, không xoá |
| 7 | `CreateAirportsAndAircraft` | 45 | `airports` (uuid + `UNIQUE code`), `aircraft` (`UNIQUE registration`), `seats` (PK `aircraft_id, row, letter`) | PK của seats chính là BR-REF-03 (không trùng vị trí) do DB thực thi |
| 8 | `ExpandFlightReferences` | 46 | Thêm `origin_airport_id`, `destination_airport_id`, `aircraft_id`, `status` (nullable) | Migration đầu tiên chạy transaction riêng |
| 9 | `BackfillFlightReferences` | 46 | Ghép sân bay theo `upper(code)`; chuyến cũ → `OPEN` | Máy bay **không** backfill — không đoán được, để người quyết |
| 10 | `ContractFlightReferences` | 46 | `NOT NULL`, FK, CHECK; xoá cột text `origin/destination` | Từ chối kèm danh sách chuyến thiếu tham chiếu |
| 11 | `AddAircraftScheduleExclusion` | 46 | `btree_gist`, hàm `IMMUTABLE flight_aircraft_occupancy()`, `EXCL_flights_aircraft_schedule` | Extension *trusted* nên role thường tạo được. `IMMUTABLE` chỉ đúng khi interval tính bằng phút |
| 12 | `CreateFlightSeats` | 47 | Bảng `flight_seats` (bản **copy** ghế), `UQ_flight_seats_booking_id`, FK deferred, partial index `idx_flight_seats_available` | FK `DEFERRABLE INITIALLY DEFERRED` cho phép giữ ghế trước khi insert booking |
| 13 | `BackfillFlightSeats` | 47 | Sinh ghế cho chuyến cũ; ghép booking cũ nhất với ghế trước nhất | Quy tắc xác định → chạy lại cho cùng kết quả |
| 14 | `ContractFlightSeats` | 47 | Xoá `flights.available_seats` | Đối soát bộ đếm cũ vs số đếm mới **lần cuối** trước khi xoá; từ chối nếu booking không có ghế |
| 15 | `MoveBookingsToLifecycle` | 48A | `active → CONFIRMED`, `cancelled → CANCELLED`; CHECK `HELD/CONFIRMED/CANCELLED/EXPIRED`; `hold_expires_at` + `CHK_bookings_hold_expiry` | Booking cũ thành CONFIRMED (không phải HELD) để job hết hạn 48B không nhả ghế của họ |
| 16 | `AddBookingReference` | 48A | Cột `reference`, `UQ` trước, backfill từng dòng, rồi `NOT NULL` + CHECK định dạng | Ngẫu nhiên từ byte 0–5 của `gen_random_uuid()` `% 32` (đều vì 256 chia hết 32), không cần pgcrypto; UQ có trước để bug vòng lặp làm fail migration |
| 17 | `CreateBookingPassengers` | 48A | Bảng `booking_passengers` (vị trí 1–9, tên, bản sao ghế); backfill mỗi booking cũ thành 1 hành khách | Phải chạy trước #19 (join dựa vào "một ghế mỗi booking") |
| 18 | `ContractBookingPassengers` | 48A | Đối soát rồi xoá `bookings.passenger_name` | Từ chối booking CONFIRMED lệch ghế/hành khách, booking CANCELLED còn giữ ghế |
| 19 | `AllowHeldSeats` | 48A | Status ghế thêm `HELD`; xoá `UQ_flight_seats_booking_id`; thêm partial index `idx_flight_seats_booking_id` | Index thay thế cái UQ từng cho "miễn phí" — cancel và job hết hạn tìm ghế theo `booking_id` |
| 20 | `AddBookingHoldExpiryIndex` | 48B | Partial index `idx_bookings_held_expiry` trên `(hold_expires_at, id) WHERE status = 'HELD'` | Chỉ chứa hold đang mở (nhỏ, bảng thì lớn mãi). Có `id` để khớp `ORDER BY hold_expires_at, id` → đọc theo thứ tự, dừng ở `LIMIT`, không Sort (chỉ `hold_expires_at` → Incremental Sort). Đo 100 000 booking: 104 buffer / 0,06 ms so với 2 990 / 8 ms. `CREATE INDEX` thường (chặn ghi lúc tạo) — bảng lớn đang chạy thì cần `CONCURRENTLY`, không chạy được trong transaction của migration |
| 21 | `CreateFlightFares` | 49A | Bảng `flight_fares`: PK `(flight_id, fare_class)`, `amount_vnd bigint`, CHECK `> 0` và `<= 2^53 − 1`, CHECK hạng | Một dòng mỗi hạng (không phải cột `economy_price`/`business_price`): không cột NULL cho máy bay chỉ có phổ thông, thêm hạng không đổi schema. Trần 2^53 − 1 vì JS `number` chỉ đúng tới đó — số lớn hơn lưu được nhưng làm chuyến không đọc được |
| 22 | `BackfillFlightFares` | 49A | Chuyến `VND` có ghế ECONOMY → giá ECONOMY = `price_in_cents` **giữ nguyên** | `price_in_cents` vốn đã là đồng (tên cột sai). **Không** đoán giá BUSINESS, **không** tỷ giá USD trong migration |
| 23 | `ContractFlightFares` | 49A | Kiểm BR-FLT-09 rồi xoá `price_in_cents`, `currency` và 2 CHECK | Từ chối kèm danh sách + HINT khi hạng có ghế mà thiếu giá, hoặc có giá mà không có ghế. Thử trên dev: lần 1 từ chối VN902 (thiếu BUSINESS) và VN903 (USD); đặt giá bằng psql; thêm cố ý một giá thừa → lần 2 từ chối đúng nó; lần 3 qua. `down` mất dữ liệu (chỉ giữ một giá) và ghi rõ |
| 24 | `AddPassengerFareSnapshot` | 49A | `booking_passengers.fare_class`, `price_vnd`; backfill theo **vị trí ghế** trên chuyến + giá **lúc chạy migration**; CHECK ghế/hạng/giá cùng NULL, giá > 0, ≤ 2^53 − 1 | Tìm ghế theo vị trí (không theo `booking_id`) để booking đã huỷ/hết hạn cũng có giá. Từ chối hành khách có ghế mà không ra giá (ghế không thuộc chuyến) |

## `identity_db` — 2 migration

| Migration | Day | Làm gì |
|---|---|---|
| `CreateUsers` | 31 | Bảng `users`, `UNIQUE(email)`, `password_hash` |
| `AddRoleToUsers` | 34 | Cột `role` (`user` / `admin`), mặc định `user` |

## Hạ tầng database

`docker/postgres-init/00-create-identity-db.sh`, `01-create-booking-db.sh`: superuser trung lập
`postgres` chỉ dùng để khởi tạo; tạo role `identity` và `booking` (`NOSUPERUSER NOCREATEDB
NOCREATEROLE`), mỗi role sở hữu database của mình, `REVOKE CONNECT … FROM PUBLIC`.

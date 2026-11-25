# Use case: báo cáo admin (Day 53)

Port đọc `AdminReports` (`api/src/reports/admin-reports.ts`), adapter
`api/src/reports/postgres/postgres-admin-reports.ts`. Đây là port đọc thứ hai, đứng cạnh
`FlightSearch`.
- Cả ba route đều cần `requireJwt` + `requireRole("admin")`: không có token → `401`, user thường → `403`.
- Quyết định thiết kế: Decision 19. User story: US-ADM-01..03.

## GetFlightManifest — `GET /api/admin/flights/:id/manifest`

**Code:** `api/src/reports/get-flight-manifest.ts`.

- **Đọc**: hai câu trong transaction `REPEATABLE READ READ ONLY`, nên số ghế và danh sách luôn khớp
  nhau.
- **Kết quả**:
  - `flight` gồm `departureLocal` và trạng thái hiệu lực.
  - `classes` liệt kê theo hạng: `total`, `booked`, `held` (hold còn hạn), `available` (gồm cả hold
    đã quá hạn mà job chưa quét).
  - `heldBookings` chỉ là **con số**, không có tên.
  - `passengers` chỉ gồm booking `CONFIRMED`, theo thứ tự ghế, mỗi người **đúng 4 trường**:
    `reference`, `name`, `seat`, `fareClass`.
- **Audit việc xem**: `FLIGHT_MANIFEST_VIEWED`, target là chuyến bay, actor là admin, metadata chỉ
  có `{ passengerCount }`. Ghi trong một transaction **riêng, sau khi đọc** (vì transaction đọc là
  READ ONLY). Nếu ghi audit lỗi thì trả `500` và **không gửi manifest**.
- **HTTP**: `200`. `404 FLIGHT_NOT_FOUND` khi id không tồn tại hoặc sai định dạng; trường hợp này
  không ghi audit.

## GetLoadFactor — `GET /api/admin/reports/load-factor`

**Code:** `api/src/reports/get-load-factor.ts`, validation `api/src/reports/report-validation.ts`.

- **Tham số**: `dateFrom`, `dateTo` là ngày địa phương **của sân bay đi**, tối đa 31 ngày. Thêm
  tuỳ chọn `origin`, `limit` (1–50, mặc định 20) và `cursor`.
- **Kết quả**: mỗi chuyến có trạng thái hiệu lực (kể cả `CANCELLED`). Mỗi hạng có `total`, `sold`,
  `held`, `available` và `loadFactor = sold ÷ total`, làm tròn 4 chữ số. Luôn đúng
  `available + held + sold = total`.
- **Truy vấn**: một câu SQL cho mỗi trang. Khoảng UTC được **nới** từ UTC+14 tới UTC−12 để dùng được
  `idx_flights_departure`, sau đó lọc lại chính xác theo ngày địa phương. Ghế của cả trang được
  đếm trong một lần.
- **Phân trang**: keyset trên `(departureAt, id)`.
- **HTTP**: `200`. `422` khi tham số sai (`DATE_RANGE_TOO_LONG`, `INVALID_DATE`…). `400 INVALID_CURSOR`
  khi cursor thuộc về bộ lọc khác.

## QueryAuditLog — `GET /api/admin/audit-logs`

**Code:** `api/src/reports/query-audit-log.ts`.

- **Bộ lọc bắt buộc**: hoặc `targetType` + `targetId`, hoặc `from` + `to` (thời điểm ISO có múi
  giờ, khoảng `[from, to)`, tối đa 31 ngày). Thiếu cả hai thì trả `422 FILTER_REQUIRED`.
- **Lọc thêm** (chỉ thu hẹp kết quả): `actorType`, `actorId`, `action`.
- **Thứ tự**: mới nhất trước, keyset trên `(occurredAt, id)` giảm dần, `limit` từ 1 đến 100.
- **Index**: `idx_audit_logs_target_occurred` và `idx_audit_logs_occurred` (migration 31).
- **Cursor**: SHA-256 gắn với **toàn bộ** bộ lọc. Dùng cursor của bộ lọc khác thì trả `400`.
- **HTTP**: `200`, `422`, `400`.

## Thay đổi khác trong Day 53

| Use case | Thay đổi |
|---|---|
| PayForBooking (pha 1) | Chuyến bay đã `CANCELLED` → lưu `409 BOOKING_NOT_PAYABLE` (lý do `flight-cancelled`), **không gọi gateway**, không tạo payment. Chỉ chặn `CANCELLED`, vì chuyến `CLOSED` vẫn được trả tiền (BR-PAY-06). Pha 3 vẫn là hàng rào cuối. |
| CascadeFlightCancellations (job) | Khi claim không còn gì, job đánh dấu `cascade_completed_at` cho mọi chuyến đã huỷ mà không còn booking sống. Kết quả trả thêm `flightsCompleted`. Câu claim chỉ đọc các chuyến chưa xong, theo thứ tự `flight.id, booking.id`. |

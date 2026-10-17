# Phỏng vấn: kiến trúc và thiết kế

### 1. Bạn tổ chức code thế nào? Vì sao?

**Trả lời:** Theo feature (`flights/`, `bookings/`…). Mỗi feature có một **port** (interface, ví
dụ `BookingRepository`) không biết gì về HTTP hay database, một **adapter** Postgres trong thư
mục `postgres/`, và các **use case** viết dạng factory `createCreateBooking(deps)`. Route trong
`app.ts` mỏng: gọi use case, switch trên `outcome`, dịch ra HTTP.
**Vì sao:** đổi storage chỉ cần adapter mới — Day 36–41 tôi chuyển SQLite → Postgres mà không sửa
use case nào.
**Code:** `api/src/bookings/booking-repository.ts`, `api/src/bookings/postgres/`.

### 2. Vì sao trả về discriminated union thay vì throw exception?

**Trả lời:** Kết quả mong đợi (trùng, hết ghế, không tìm thấy) là một phần của nghiệp vụ, caller
**bắt buộc** phải xử lý — TypeScript ép switch đủ case. `throw` chỉ dành cho lỗi không lường trước
(bug, DB chết), được middleware lỗi bắt và trả 500 chung. Có test khẳng định lỗi bất ngờ **không
bị nuốt**.
**Ví dụ:** `CreateBookingResult = created | validation_failed | not-enough-seats | seats-unavailable | unknown-seats | sales-closed | flight-not-found`.

### 3. Dependency Injection làm thế nào? Có dùng container không?

**Trả lời:** DI tay. Một Composition Root duy nhất (`api/src/bootstrap/application.ts`) tạo mọi
hạ tầng và nối vào use case. Không dùng container vì graph còn nhỏ; container (tsyringe) để
phase E khi có bằng chứng cần. Đồng hồ, bộ sinh id, requestId cũng được inject → test xác định.

### 4. Vì sao làm monolith trước rồi mới tách service?

**Trả lời:** Ranh giới service phải được kiểm chứng bằng use case thật. Tách khi domain chưa ổn
định dễ thành distributed monolith. Tôi đã tách hai service có ranh giới rõ (identity,
notifier); Flight/Booking chỉ tách sau khi domain hoàn thiện (ADR-007).

### 5. Khi nào bạn thêm một pattern mới (CQRS, Mediator…)?

**Trả lời:** Khi codebase cho thấy **cơn đau** mà pattern giải quyết, hoặc có lý do phi kỹ thuật
được ghi rõ. Ví dụ: Outbox (Day 24) được thêm sau khi tôi chứng minh dual-write làm mất event lúc
broker chết; CQRS bị dời sang phase E vì ~5 use case chưa đủ bằng chứng. Tôi cũng từng **đảo**
quyết định: Day 22 copy contract giữa service, Day 27 chuyển sang package dùng chung khi số event
× consumer tăng (ADR-002 → 003).

### 6. Thiết kế domain: vì sao trạng thái ghế nằm ở phía Flight mà không ở Booking?

**Trả lời:** Luật "một ghế bán tối đa một lần" là luật của **tồn kho chuyến bay**. Đặt ở
`flight_seats` cho phép giữ nguyên kiểu conditional UPDATE trên một dòng ghế. Booking chỉ giữ bản
sao mã ghế để hiển thị. Khi tách service, Flight service chỉ biết "reservation id" (booking id),
không biết hành khách (Decision 10–11).

### 7. Vì sao không lưu trạng thái `CLOSED`/`DEPARTED` của chuyến bay?

**Trả lời:** Chúng chỉ phụ thuộc thời gian. Lưu thì cần job cập nhật, và job sẽ race với người
đang đặt vé. Tính lúc đọc (`effectiveFlightStatus`) luôn đúng tại mọi thời điểm, không job, không
race (ADR-008). Câu giữ ghế tự kiểm cửa sổ bán vé trong `WHERE`.

### 8. Một quyết định bạn đã thay đổi giữa chừng?

**Trả lời:** Event `booking-created`. Khi thêm trạng thái `HELD` (giữ ghế 15 phút, chưa trả tiền),
tôi không đổi nghĩa event cũ — consumer gửi email "đã xác nhận" sẽ nhận nhầm. Tôi tạo event mới
`booking-held`, giữ consumer cũ để đọc message còn tồn trong queue/DLQ, và dành
`booking-confirmed` cho bước thanh toán.

### 9. Breaking change ở API xử lý sao?

**Trả lời:** Trường cũ bị từ chối **có tên** (`422 UNSUPPORTED_FIELD` kèm "passengerName đã được
thay bằng passengers"), không lặng lẽ bỏ qua — client biết ngay phải sửa gì. Ghi vào README và
Postman.

### 10. Hết hạn: lưu trạng thái hay suy ra khi đọc?

**Trả lời:** Cả hai, tuỳ ai hỏi (Decision 12). Tồn kho ghế do **job** đổi thật, vì suy ra thì mỗi
lần đếm ghế phải join `bookings` và câu giữ ghế phải "cướp" ghế còn ghi `HELD`. Trạng thái booking
thì **suy ra khi đọc** (`HELD` quá hạn hiển thị `EXPIRED`), giống `CLOSED` của chuyến bay. Còn quyết
định (huỷ, thanh toán) **tự kiểm hạn trong `WHERE`**, không tin job. Đánh đổi chấp nhận: sơ đồ ghế
trễ tới ~60 s — ghế vẫn không bán hai lần được.

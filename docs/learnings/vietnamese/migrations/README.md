# Migration — nguyên tắc

Danh sách đầy đủ từng migration: [danh-sach.md](./danh-sach.md).

## 1. Viết tay, review được

Mọi migration là SQL viết tay trong class TypeORM (`api/src/postgres/migrations/`), **không** dùng
diff tự sinh và `synchronize: false`. Lý do: thấy chính xác constraint nào, tên gì — vì code map
lỗi theo **tên constraint** (`UQ_bookings_reference`, `EXCL_flights_aircraft_schedule`…).

## 2. Expand → backfill → contract

Khi đổi schema trên bảng đã có dữ liệu:

| Bước | Làm gì | Ví dụ |
|---|---|---|
| **Expand** | Thêm cột/bảng **cho phép NULL**; dữ liệu cũ vẫn hợp lệ | `ExpandFlightReferences`, `CreateFlightSeats`, `CreateBookingPassengers` |
| **Backfill** | Điền dữ liệu mới từ dữ liệu cũ, **idempotent** (chỉ điền chỗ còn NULL) | `BackfillFlightReferences`, `BackfillFlightSeats` |
| **Contract** | Đối soát → nếu ổn mới `NOT NULL`, FK, CHECK, xoá cột cũ | `ContractFlightReferences`, `ContractFlightSeats`, `ContractBookingPassengers` |

## 3. Contract **từ chối**, không bao giờ xoá hay "sửa hộ"

Khối `DO $$ … $$` gom mọi dòng lệch rồi `RAISE EXCEPTION` kèm danh sách và `HINT` hướng xử lý.
Quyết định bên nào đúng (huỷ booking nào, gán máy bay nào) là việc của **con người**. Migration âm
thầm xoá dữ liệu là thói quen làm mất dữ liệu production sau này.

Ví dụ đã chạy thật trên dữ liệu dev cố tình làm lệch:
- Day 46: từ chối, nêu VN999 (sân bay `XXX` không tồn tại) và VN123 (không có máy bay).
- Day 47: từ chối, nêu 2 booking không có ghế của VN703 (bán 70 vé trên 68 ghế) và bộ đếm VN702 lệch (120 vs 175).
- Day 48A: từ chối booking CONFIRMED không có ghế và booking CANCELLED vẫn giữ ghế.

## 4. Mỗi migration một transaction

`migrationsTransactionMode: "each"` (`api/src/postgres/data-source.ts`, từ Day 46). Contract bị từ
chối thì expand + backfill **vẫn được giữ** → người sửa dữ liệu tay → chạy lại migration. Day 44
còn chạy chung một transaction: contract từ chối kéo theo rollback cả expand.

## 5. Thứ tự có ý nghĩa

Day 48A: `CreateBookingPassengers` (backfill bằng `LEFT JOIN flight_seats`) phải chạy **trước**
`AllowHeldSeats` (xoá `UQ_flight_seats_booking_id`) — vì phép join dựa vào "mỗi booking tối đa một
ghế"; bỏ ràng buộc trước thì join sinh một hành khách cho mỗi ghế. CHECK `HELD` cần
`hold_expires_at` phải tồn tại trước khi code ghi `HELD`.

## 6. Kiểm cả chiều `down`

Ở Day 48A, `down()` của `MoveBookingsToLifecycle` và `AllowHeldSeats` cũng **từ chối** khi không thể
quay lại an toàn (còn booking `HELD`/`EXPIRED`, còn ghế `HELD`, hoặc booking giữ nhiều hơn một ghế);
`ContractBookingPassengers.down()` khôi phục `passenger_name` từ hành khách số 1. Đã chạy thử
down/up trên dữ liệu dev.

## 7. Probe constraint trong transaction rồi rollback

Sau khi chạy, thử ghi dữ liệu sai vào từng constraint mới trong `BEGIN … ROLLBACK` để chắc nó thật
sự chặn (ví dụ chuyến sau đúng +45 phút được nhận, +44 phút bị `23P01`).

## 8. Không index "phòng hờ"

Index chỉ thêm khi có query cần nó, và hình dạng theo đúng query đó. `audit_logs` không có index nào
ngoài PK vì chưa có gì đọc nó. Cột FK không tự có index trong Postgres → thêm khi cần (`idx_bookings_flight_id`).

## 9. Giới hạn

Migration chạy trong process lúc khởi động — an toàn khi chỉ một instance. Zero-downtime thật (code
cũ và mới chạy song song) cần thêm bước CHECK "rộng" chấp nhận cả giá trị cũ lẫn mới, release
trước khi đổi code (ghi chú trong `MoveBookingsToLifecycle`).

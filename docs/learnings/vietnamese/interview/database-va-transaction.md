# Phỏng vấn: database và transaction

### 1. Làm sao để nhiều repository dùng chung một transaction mà port không lộ kiểu ORM?

**Trả lời:** `TransactionRunner.run(fn)` mở transaction và đặt `EntityManager` vào
`AsyncLocalStorage`. Mỗi repository **resolve manager ở mỗi lần gọi** (`resolveEntityManager`):
đang trong transaction thì dùng manager đó, không thì dùng pool.
**Bẫy đã gặp (Day 37):** repository resolve `getRepository()` một lần lúc tạo → bị gắn vào pool,
**không bao giờ tham gia transaction**; mọi test vẫn xanh, chỉ test rollback chéo nhiều bảng mới
lộ. Giờ có test tái hiện lỗi cũ để chống tái phát.
**Code:** `api/src/postgres/transaction-context.ts`, `api/src/transactions/postgres-transaction-runner.ts`.

### 2. Điều gì xảy ra nếu bạn bắt một lỗi SQL bên trong transaction rồi chạy tiếp?

**Trả lời:** Postgres đánh dấu transaction là aborted: mọi câu sau báo "current transaction is
aborted", và **COMMIT không throw mà âm thầm ROLLBACK** (đã xác nhận bằng psql và pg client, Day
38). Quy tắc: lỗi DB bị bắt trong transaction phải kết thúc công việc của transaction đó. Nếu cần
tiếp tục (trùng mã đặt chỗ), dùng `INSERT … ON CONFLICT DO NOTHING RETURNING` thay vì bắt `23505`.

### 3. Transaction lồng nhau?

**Trả lời:** TypeORM không chặn: `dataSource.transaction()` lồng nhau âm thầm mở transaction thứ
hai độc lập. Tôi tự ném `NestedTransactionError` để lỗi lập trình lộ ra sớm.

### 4. Migration schema an toàn khi đã có dữ liệu?

**Trả lời:** **Expand → backfill → contract.**
1. Expand: thêm cột/bảng cho phép NULL.
2. Backfill: điền dữ liệu từ cái cũ.
3. Contract: khối `DO` **đối soát**; nếu dữ liệu lệch thì `RAISE EXCEPTION` kèm danh sách dòng và
   `HINT` cách sửa — **không bao giờ tự xoá**. Ổn thì mới `NOT NULL`, thêm FK/CHECK, bỏ cột cũ.

Mỗi migration chạy transaction riêng (`migrationsTransactionMode: "each"`) để contract bị từ chối
không kéo theo expand/backfill. Tôi luôn thử trên dữ liệu dev **cố tình làm lệch** (chuyến bán quá
số ghế, booking không có ghế) để chắc nó biết từ chối.
**Ví dụ:** `ContractBookingPassengers` đối soát "booking CONFIRMED: số ghế BOOKED = số hành khách
= số bản sao ghế khớp".

### 5. Vì sao dùng FK `DEFERRABLE INITIALLY DEFERRED` cho `flight_seats.booking_id`?

**Trả lời:** CreateBooking giữ ghế **trước** khi insert booking (sinh booking id trước). Nhờ vậy
giữ ghế thất bại chỉ tốn một câu lệnh và không ghi gì cần hoàn tác. FK deferred kiểm lúc COMMIT,
khi booking đã tồn tại. Bonus: nó chặn luôn trường hợp ghế mồ côi nếu code có bug commit một nửa.

### 6. `availableSeats` lưu hay tính?

**Trả lời:** Tính khi đọc (Day 47) — bộ đếm là bản sao thứ hai của sự thật và đã từng lệch
(dữ liệu dev: bộ đếm 120 nhưng thực tế 175). Tính bằng scalar subquery qua partial index
`idx_flight_seats_available` → Index Only Scan, 1,4 ms trang đầu với 352 nghìn ghế.
Dùng scalar subquery chứ không `JOIN … GROUP BY` vì chuyến hết ghế phải hiện `0`, không biến mất
(mutation đổi sang JOIN làm test fail).
**Giới hạn đã đo:** OFFSET sâu chậm (trang 100: 52 ms) vì subquery chạy cả cho các dòng bị bỏ qua.

### 7. Index bạn thiết kế dựa trên gì?

**Trả lời:** Theo **query thật**. `idx_bookings_owner_created (owner_account_id, created_at DESC,
id DESC)` khớp đúng "list booking của tôi, mới nhất trước". Partial index `WHERE status =
'AVAILABLE'` cho đếm ghế; partial index outbox `WHERE published_at IS NULL` cho relay. Kiểm bằng
EXPLAIN, không đoán.

### 8. Least privilege với Postgres?

**Trả lời:** Mỗi service một role `NOSUPERUSER NOCREATEDB NOCREATEROLE`, sở hữu đúng database của
nó, `REVOKE CONNECT … FROM PUBLIC`. Có integration test khẳng định "không phải superuser".
**Câu chuyện:** identity đã chạy bằng superuser suốt 9 ngày mà không ai biết (Day 42); và test
integration từng chạy bằng superuser nên che mất lỗi quyền (Day 40).

### 9. Một bẫy TypeORM?

**Trả lời:** `UpdateQueryBuilder.returning("flight_id")` — truyền tên cột thay vì tên property thì
TypeORM **lặng lẽ bỏ** mệnh đề RETURNING, `raw` rỗng, không báo lỗi (Day 39).

### 10. Lưu tiền thế nào? (Day 49A)

**Trả lời:** Số nguyên theo đơn vị nhỏ nhất của tiền tệ, không bao giờ float (`0.1 + 0.2 !== 0.3`).
VND không có đơn vị con đang dùng → lưu **số đồng nguyên**, không nhân 100. Cột Postgres `bigint`;
trong TypeScript là `number` vì giá vé còn xa giới hạn 2^53 − 1. `pg` trả `bigint` dưới dạng
**chuỗi**, nên adapter parse bằng regex số nguyên + kiểm safe integer và **throw** nếu sai;
thêm `CHECK (amount_vnd <= 9007199254740991)` để DB từ chối ngay lúc ghi.
**Câu chuyện:** cột cũ tên `price_in_cents` nhưng thật ra chứa đồng (`1500000` = 1,5 triệu đồng).
Tên cột không phải đơn vị — chỉ cần một chỗ đọc chia 100 là giá thành 15 nghìn. Giờ đơn vị nằm
trong tên (`amount_vnd`) và trong kiểu (`Money`). Hai bẫy parse đã có test: `Number("")` là `0`,
`Number("9007199254740993")` làm tròn im lặng.

### 11. Một luật database không khai báo được thì giữ ở đâu? (Day 49A)

**Trả lời:** BR-FLT-09: "hạng nào có ghế thì có giá, không có ghế thì không có giá". `CHECK` chỉ
thấy một dòng, FK chỉ trỏ một chiều → không ràng buộc nào nói được "với mỗi hạng trong
`flight_seats` phải có một dòng trong `flight_fares`". Nên ghi rõ **ứng dụng** giữ: CreateFlight
trả `422 MISSING_FARE` / `FARE_CLASS_NOT_ON_AIRCRAFT`; migration contract kiểm dữ liệu cũ và từ chối
kèm danh sách; câu giữ ghế **throw** nếu gặp ghế không có giá (bất biến hỏng phải ồn ào). Trigger
làm được nhưng chưa đáng khi chỉ một use case ghi giá.

### 12. `json` hay `jsonb`? Một lần chọn sai (Day 49B)

**Trả lời:** `jsonb` lưu dạng nhị phân đã chuẩn hoá: query/index bên trong được, nhưng **sắp xếp
lại key** và bỏ khoảng trắng. `json` lưu nguyên văn. Response của Idempotency-Key ban đầu là
`jsonb`; e2e so từng byte thấy câu trả lời phát lại có `details` đứng trước `message`. Contract test
không bắt được vì dùng `deepEqual` (không quan tâm thứ tự key). Sửa: cột `json`, test so
`JSON.stringify`. Quy tắc: cần truy vấn bên trong → `jsonb`; cần trả lại đúng như đã nhận → `json`.

### 13. Partial unique index để làm gì? `ON CONFLICT` với nó viết thế nào? (Day 49B)

**Trả lời:** Ràng buộc "tối đa một dòng ở trạng thái X cho mỗi cha":
`CREATE UNIQUE INDEX … ON payments (booking_id) WHERE status = 'SUCCEEDED'` (BR-PAY-05). Insert
dùng `ON CONFLICT ("booking_id") WHERE "status" = 'PROCESSING' DO NOTHING` — phải **lặp lại
predicate** để Postgres suy ra đúng partial index làm trọng tài. Trùng thì `INSERT 0 0`, không có
`23505`, nên transaction vẫn dùng tiếp được (bắt `23505` trong transaction sẽ làm nó bị abort).

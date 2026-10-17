# Phỏng vấn: testing

### 1. Chiến lược test của bạn?

**Trả lời:** Hai tầng (ADR-005):
- **Unit/HTTP** trên **fake in-memory** viết tay (không thư viện mock): logic nghiệp vụ, validation,
  mapping HTTP. Nhanh, không cần hạ tầng. `npm test` — hiện 351 test.
- **Integration** trên **Postgres thật**: transaction, constraint, migration, race. 122 test.

Fake không mô phỏng rollback hay khoá — đó là hành vi của DB, chỉ test trên DB thật. **Không bao
giờ test race trên fake** vì fake đơn luồng không thể fail.

### 2. Làm sao chắc fake không khác Postgres?

**Trả lời:** **Contract test**: một bộ hành vi (`tests/contracts/booking-repository.contract.ts`)
chạy trên **cả** fake và adapter Postgres. Fake sai lệch thì contract fail. Đã chứng minh bằng cách
làm hỏng fake: 6/7 case fail.

### 3. Mutation testing là gì, bạn làm thế nào?

**Trả lời:** Cố tình sửa hỏng đúng chỗ code bảo vệ một luật, chạy test, **đúng** test tương ứng
phải fail, rồi hoàn tác và `grep MUTATION` = 0. Không dùng tool, làm tay cho từng thay đổi quan
trọng. Ví dụ: bỏ `enough.ok` → test commit một nửa fail; bỏ scope → 4 test BOLA fail.
**Mutation sống sót** là phát hiện: bỏ `ORDER BY` khi khoá ghế mà test vẫn xanh → EXPLAIN cho thấy
plan tình cờ sort.

### 4. Test race condition thế nào?

**Trả lời:** Trên Postgres thật, qua use case thật, `Promise.all` N request; dùng **barrier** để ép
thứ tự xen kẽ; **control test** bỏ từng cơ chế để đo; kết thúc bằng kiểm bất biến trên bảng; chạy
10 lần liên tiếp. Chi tiết: [../race-conditions/06-cach-test-race-condition.md](../race-conditions/06-cach-test-race-condition.md).

### 5. Xử lý thứ không xác định (thời gian, id ngẫu nhiên)?

**Trả lời:** Inject qua dependency: `getCurrentTime: () => FIXED_TIME`, `generateId`,
`generateReference`. Test ép trùng mã đặt chỗ bằng cách cho `generateReference` trả cùng một mã.

### 6. Một lần test "xanh" nhưng sai?

**Trả lời:**
- Day 36: npm chạy script bằng `sh` không có globstar → `tests/**/*.test.ts` chỉ khớp một cấp,
  **23 file test biến mất** mà vẫn xanh. Phát hiện nhờ nhìn số test. Từ đó luôn **đối chiếu số
  test**: `trước − xoá + thêm = sau`.
- Day 37: repository không tham gia transaction, mọi test xanh; chỉ test rollback chéo bảng lộ ra.
- Day 47: test index outbox fail sau race test vì autovacuum + TRUNCATE làm planner chọn Seq Scan
  → sửa test thành "index **có thể** phục vụ query" (`enable_seqscan = off`).

### 7. Test HTTP viết thế nào?

**Trả lời:** `supertest` chạy trên `createApp()` với fake. Tên test là câu mô tả hành vi đầy đủ
(“another account's booking answers GET exactly like a missing one: 404 with the same body”).
Có test allow-list key cho response công khai.

### 8. E2E?

**Trả lời:** Mỗi ngày kết thúc bằng e2e trên docker compose: gọi HTTP, kiểm bảng bằng psql, đọc log
notifier, chạy folder Postman bằng newman. Ví dụ Day 48A: 10 request đồng thời 3 khách trên chuyến
10 ghế → 3×201, 7×409, còn 1 ghế, psql xác nhận không ghế mồ côi.

### 9. Test một thứ phụ thuộc thời gian (hold 15 phút) thế nào?

**Trả lời:** Không làm thời lượng thành config chỉ để test. Unit: đồng hồ inject, test **đúng tại
thời điểm hạn** và trước 1 ms (cách xa 1 phút không phân biệt `<` với `<=`). Có cả đồng hồ giả
**nhảy ngay sau khi bị đọc** để bắt code đọc `now` nhiều lần trong một lần chạy job. E2E: lùi
`hold_expires_at` bằng psql rồi chờ job 60 s; Postman tách 2 folder, bước psql ở giữa.

### 10. Một mutation "fail" nhưng không phải bằng chứng?

**Trả lời:** Day 48B tôi bỏ điều kiện `hold_expires_at > $2` khỏi câu huỷ; 14 test fail — nhưng vì
`$2` không còn được dùng, Postgres không suy được kiểu tham số, tức là **lỗi SQL**, không phải hành
vi sai. Làm lại giữ `$2` (`$2::timestamptz IS NOT NULL`) → đúng 1 test biên fail. Ngược lại có
mutation **sống sót** (bỏ `ORDER BY` khi nhả ghế) và tôi ghi nó lại thay vì giấu.

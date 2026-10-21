# Phỏng vấn: concurrency

Chi tiết từng kỹ thuật ở [../race-conditions/](../race-conditions/README.md). File này là dạng hỏi–đáp.

### 1. Làm sao chống overbooking?

**Trả lời:** Không đọc rồi mới ghi. Mỗi ghế là một dòng; giữ ghế là **một câu lệnh** khoá ghế
(`FOR UPDATE`), kiểm điều kiện và UPDATE trong cùng câu. DB đảm bảo hai transaction không cùng
giữ một dòng.
**Bằng chứng:** bản read-check-update ngây thơ: 20/20 request "thành công" trên 5 ghế. Bản thật:
20 request / 5 ghế → đúng 5 thành công, 15 hết ghế, ghế 1A–1E.

### 2. Optimistic hay pessimistic locking?

**Trả lời:** Tuỳ hình dạng bài toán:
- **Một dòng, chuyển trạng thái** (huỷ booking, mở chuyến) → optimistic: `UPDATE … WHERE status = :expected`, đếm dòng bị ảnh hưởng.
- **Chọn một trong nhiều** (ghế bất kỳ) → khoá dòng + `SKIP LOCKED`. OCC thuần ở đây cho 15–16/20 báo hết ghế sai vì ai cũng nhắm cùng ghế rẻ nhất.
- **Tài nguyên đích danh, nhiều dòng** → khoá bi quan theo thứ tự toàn cục.

Khoá chỉ sống trong một transaction ngắn, không bao giờ giữ qua thời gian người dùng suy nghĩ.

### 3. `SKIP LOCKED` là gì, dùng khi nào?

**Trả lời:** Khi khoá dòng, bỏ qua dòng đang bị transaction khác khoá thay vì chờ. Hợp với tài
nguyên **thay thế được** (ghế bất kỳ, job queue). **Không** hợp khi khách chọn đích danh — sẽ âm
thầm bỏ mất ghế họ chọn.
**Điều thú vị đã đo:** bỏ `SKIP LOCKED` trên Postgres **không** gây báo hết ghế sai (dòng fail
re-check bị bỏ, thử dòng tiếp) — cái giá là xếp hàng. Tôi từng dự đoán sai điều này và sửa ADR
theo số đo.

### 4. Deadlock xảy ra thế nào và bạn chống ra sao?

**Trả lời:** A giữ 12A chờ 12B, B giữ 12B chờ 12A. Chống bằng **thứ tự khoá toàn cục**: mọi câu
khoá nhiều ghế dùng `ORDER BY row, letter FOR UPDATE`, nên ai cũng xin 12A trước.
**Số đo:** khoá theo thứ tự request → deadlock 98/100 vòng (không phải hiếm!). Khoá có thứ tự → 0.
**Chi tiết hay:** bỏ `ORDER BY` mà test vẫn xanh — plan tình cờ sort khi loại trùng danh sách
`IN`. Tôi giữ `ORDER BY` vì plan không phải lời hứa.

### 5. Ghi nhiều dòng "tất cả hoặc không" — transaction chưa đủ sao?

**Trả lời:** Chưa đủ. Nếu code UPDATE được 2/3 ghế rồi **trả về** "không đủ ghế", use case không
throw nên transaction **commit** → 2 ghế kẹt. Phán quyết phải nằm trong `WHERE` của chính câu
UPDATE (`WHERE enough.ok`): thiếu ghế thì không ghi dòng nào.

### 6. Hai admin cùng xếp một máy bay vào hai chuyến chồng giờ?

**Trả lời:** Exclusion constraint GiST `(aircraft_id WITH =, khoảng thời gian WITH &&)`. Điều thú
vị: hai insert **đồng thời** ra `40P01` deadlock chứ không phải `23P01` — tôi map nó thành 409 và
ghi rõ giả định an toàn (insert là câu ghi đầu tiên).

### 7. Một race bạn **xoá bỏ** được thay vì xử lý?

**Trả lời:** Trạng thái `CLOSED` của chuyến bay: tính từ đồng hồ thay vì job cập nhật → không có
race job-đóng-bán vs người-đặt-vé.

### 8. Isolation level bạn dùng?

**Trả lời:** READ COMMITTED (mặc định Postgres). Đủ vì mọi chỗ tranh chấp đều được xử lý bằng
khoá dòng hoặc điều kiện trong câu ghi; READ COMMITTED đánh giá lại `WHERE` trên phiên bản mới
nhất sau khi chờ khoá. Không cần SERIALIZABLE và retry khắp nơi.

### 9. Làm sao biết race test của bạn có giá trị?

**Trả lời:** Chạy trên Postgres thật, có **control test** bỏ từng cơ chế để thấy nó hỏng, có
**mutation** để chắc test fail khi code sai, dùng **barrier** để ép thứ tự xen kẽ, chạy 10 lần
liên tiếp. Xem [../race-conditions/06-cach-test-race-condition.md](../race-conditions/06-cach-test-race-condition.md).

### 10. Job hết hạn giữ ghế chạy trên 2 instance cùng lúc thì sao?

**Trả lời:** Mỗi lô là `… ORDER BY hold_expires_at, id LIMIT 50 FOR UPDATE SKIP LOCKED` trong một
transaction: instance thứ hai bỏ qua dòng đang bị khoá và lấy lô kế. Không có booking nào hết hạn
hai lần. Tôi còn đo đối chứng: bỏ `SKIP LOCKED` **vẫn đúng** (người chờ re-check `status = 'HELD'`
sau khi được khoá) nhưng các sweeper xếp hàng — ~910 ms so với ~250 ms, 0 lô chạy chồng. Tức là
`SKIP LOCKED` ở đây mua **không chờ**, không phải tính đúng. (Outbox relay thì chưa an toàn đa
instance — tôi nói rõ giới hạn đó.)

### 11. Huỷ và hết hạn xảy ra cùng mili-giây?

**Trả lời:** Hai câu UPDATE có điều kiện **bổ sung**: huỷ `hold_expires_at > now`, hết hạn
`hold_expires_at <= now`. Cùng `now` thì chỉ một khớp; đúng lúc hạn thì hết hạn thắng 20/20 và huỷ
trả `409 BOOKING_EXPIRED`. Nếu hai bên đọc đồng hồ lệch vài ms thì row lock cho một bên qua, bên kia
re-check trên dòng đã commit và không khớp → mỗi booking đúng một kết thúc, một audit, một event.
Quan trọng: câu huỷ **tự kiểm hạn**, không dựa vào việc job đã chạy.

### 12. Một deadlock bạn tìm ra bằng phân tích, không phải từ bug?

**Trả lời:** Khi lập bảng thứ tự khoá cho giữ ghế / huỷ / hết hạn (Day 48B), tôi thấy giữ ghế chỉ
định khoá ghế theo (row, letter) **bất kể trạng thái**, còn huỷ nhả ghế bằng
`UPDATE … WHERE booking_id` — thứ tự quét. Tôi tái hiện bằng một transaction "cổng" giữ 12A: hold
xếp hàng trước, release tới sau → nhả ngược thứ tự deadlock 5/5. Sửa: CTE khoá trước có
`ORDER BY flight_id, row, letter FOR UPDATE`, dùng chung cho huỷ và hết hạn → 0 deadlock.

### 13. Giá đổi đúng lúc khách đang giữ ghế thì sao? (Day 49A)

**Trả lời:** Khách trả giá **lúc giữ ghế**: mỗi hành khách chép giá hạng ghế của mình, tổng suy ra
từ đó. Giá được đọc **trong chính câu giữ ghế**, khoá dòng giá `FOR SHARE`:
- một câu lệnh → mọi ghế một booking lấy giá từ một snapshot, không bao giờ BUSINESS giá cũ +
  ECONOMY giá mới;
- `FOR SHARE` → đổi giá (`UPDATE flight_fares`) phải chờ hold đang mở, và hold gặp lần đổi giá chưa
  commit thì chờ rồi đọc giá mới. Không có khoá thì một booking có thể commit **sau** khi giá mới
  có hiệu lực mà vẫn mang giá cũ — race test đối chứng chứng minh điều đó.
**Điểm cộng khi kể:** một CTE `SELECT … FOR SHARE` mà không ai đọc thì Postgres **không chạy** nó →
không có khoá, mà giá trả về vẫn đúng. Mutation "lấy giá bằng subquery thay vì JOIN CTE" chỉ race
test bắt được. Và test "không bao giờ trộn giá" **vẫn xanh khi bỏ khoá** — nên tôi không dùng nó để
chứng minh khoá; test chứng minh là test có một bên phải **chờ**.

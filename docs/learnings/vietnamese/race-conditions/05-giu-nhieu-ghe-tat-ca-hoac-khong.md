# 05 — Giữ nhiều ghế: tất cả hoặc không, và thứ tự khoá

Day 48A: một booking có 1–9 hành khách. Gia đình 3 người: hoặc giữ đủ 3 ghế, hoặc không giữ ghế
nào (BR-SEAT-02). Có **hai bẫy** chỉ xuất hiện khi ghi nhiều dòng.

## Bẫy 1 — Commit một nửa

```text
UPDATE những ghế tìm được (được 2)  →  thấy 2 < 3  →  return "not-enough-seats"
```

Use case **trả về** outcome (không throw) → `TransactionRunner` **commit** → 2 ghế bị kẹt `HELD`
cho một booking không bao giờ được tạo. Transaction không cứu được, vì về mặt kỹ thuật không có
lỗi nào.

### Cách xử lý: phán quyết nằm trong `WHERE` của chính câu UPDATE

```sql
WITH candidates AS (
  SELECT … ORDER BY row, letter LIMIT $n FOR UPDATE OF seat SKIP LOCKED FOR SHARE OF flight
), enough AS (
  SELECT count(*) = $n AS ok FROM candidates
)
UPDATE flight_seats seat SET status = 'HELD', booking_id = $bookingId
FROM candidates, enough
WHERE enough.ok AND (seat.flight_id, seat.row, seat.letter) = (candidates.…)
RETURNING seat.row, seat.letter
```

Thiếu ghế → `enough.ok = false` → UPDATE match 0 dòng → **không ghi gì**. Không có gì để hoàn
tác nên commit hay rollback đều an toàn.

Ghế khách chọn dùng cùng mẫu với CTE `verdict`:
`count(*) = $n AND bool_and(status = 'AVAILABLE')`.

### Lưới an toàn thứ hai (tình cờ phát hiện)

Mutation bỏ `enough.ok` → hai ghế trỏ tới booking id chưa từng được insert → FK
`FK_flight_seats_booking_id` (`DEFERRABLE INITIALLY DEFERRED`) chặn ở **COMMIT**. Tốt, nhưng nó
biến `409` thành `500`. Câu lệnh vẫn phải tự từ chối.

## Bẫy 2 — Deadlock khi khách chọn ghế

```text
A [12A, 12B]: khoá 12A ─────► chờ 12B
B [12B, 12A]: khoá 12B ─────► chờ 12A     → vòng chờ → Postgres huỷ một bên: 40P01
```

### Cách xử lý: mọi câu khoá nhiều ghế đều khoá theo (row, letter)

`ORDER BY seat.row, seat.letter FOR UPDATE OF seat` — trong plan, `LockRows` nằm **trên** `Sort`
nên dòng được khoá theo đúng thứ tự đã sắp. Thứ tự trong request không quan trọng.

### Số đo (`postgres-booking-hold-race.integration.test.ts`)

| Test | Kết quả |
|---|---|
| B: `[12A,12B]` vs `[12B,12A]`, 20 vòng × 10 lần chạy | 1 thành công + 1 `seats-unavailable` mỗi vòng, **0 deadlock** |
| C: control khoá từng ghế theo thứ tự request + **barrier** sau ghế đầu | deadlock **10/10** |
| C không barrier | deadlock **98/100** — không hề "hiếm" |
| Mutation: `ORDER BY` theo vị trí trong request | Test B fail ngay với `40P01` — hai câu lệnh **đơn** cũng deadlock được |

### Mutation sống sót — bài học lớn nhất

Bỏ hẳn `ORDER BY` → Test B **vẫn xanh**. EXPLAIN cho thấy planner loại trùng danh sách `IN (…)`
bằng `Unique` trên `Sort (row, letter)` → khoá vẫn theo thứ tự, **do tình cờ của plan**. Plan
khác (danh sách lớn hơn, thống kê khác) không hứa gì. → **`ORDER BY` là lời bảo đảm; plan thì
không.** Đã ghi thành comment trong `holdChosenSeats`.

## Bẫy phụ — `SKIP LOCKED` với nhiều ghế

Hai booking tự chọn cùng tranh mấy ghế cuối có thể mỗi bên khoá được một phần và bỏ qua phần của
bên kia → cả hai thấy không đủ → cả hai `NOT_ENOUGH_SEATS`. Đo 200/200 vòng: chưa xảy ra. Chấp
nhận vì client thử lại sẽ được; ghi trong README limitations.

## Bất biến kiểm cuối mỗi race test

```text
số ghế HELD = số hành khách của các booking HELD
không có ghế HELD nào thuộc booking không HELD (mồ côi)
mỗi bản sao mã ghế trong booking_passengers khớp một ghế HELD cho đúng booking đó
```

## Câu trả lời phỏng vấn 30 giây

> "Ghi nhiều dòng thì phán quyết phải nằm trong chính câu UPDATE — `WHERE enough.ok` — chứ không
> kiểm sau, vì trả về một outcome bình thường thì transaction vẫn commit. Còn khi phải chờ khoá
> nhiều dòng thì tôi khoá theo một thứ tự toàn cục. Tôi có một mutation bỏ `ORDER BY` mà test
> vẫn xanh — EXPLAIN cho thấy plan tình cờ đã sort — nên tôi giữ `ORDER BY` như một bảo đảm
> tường minh."

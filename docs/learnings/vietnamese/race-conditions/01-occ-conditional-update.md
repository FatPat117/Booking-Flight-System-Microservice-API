# 01 — OCC bằng conditional UPDATE

## Vấn đề

Hai request cùng huỷ một booking, hoặc (thời còn bộ đếm ghế) cùng đặt chỗ cuối cùng:

```text
A: SELECT status → 'active'          B: SELECT status → 'active'
A: UPDATE → cancelled, nhả ghế       B: UPDATE → cancelled, nhả ghế LẦN NỮA ❌
```

Day 39 đo bản "đọc → kiểm → ghi" với 20 request trên 5 ghế: **cả 20 đều thành công**, số ghế
cuối là 4 (mỗi request tính `5 - 1` từ cùng một lần đọc cũ) — lost update.

## Cách xử lý

Đưa điều kiện vào **chính câu UPDATE** và đếm số dòng bị ảnh hưởng:

```sql
UPDATE bookings SET status = 'CANCELLED'
WHERE id = $1 AND status IN ('HELD', 'CONFIRMED')   -- điều kiện = phần "kiểm tra"
RETURNING id, flight_id
```

- 1 dòng → mình thắng, làm tiếp.
- 0 dòng → thua hoặc không tồn tại; **chỉ lúc này** mới chạy một câu SELECT phụ để chọn mã lỗi
  (`not-found` hay `already-cancelled`). Câu phụ không quyết định gì, chỉ phân loại.

Postgres (READ COMMITTED) xử lý phần còn lại: request thua phải **chờ khoá dòng**, rồi
**đánh giá lại `WHERE` trên phiên bản mới nhất** → không khớp → 0 dòng.

## Nâng cấp ở Day 47–48A: hai lần ghi trong một câu

Huỷ booking còn phải nhả ghế. Nếu tách hai câu, request thua có thể vẫn chạy câu nhả ghế. Giải
pháp là **data-modifying CTE**: ghế chỉ được nhả cho đúng dòng mà UPDATE đầu tiên thật sự huỷ.

```sql
WITH cancelled AS (
  UPDATE bookings SET status = 'CANCELLED'
  WHERE id = $1 AND status IN ('HELD','CONFIRMED') <scope chủ sở hữu>
  RETURNING id, flight_id
), released AS (
  UPDATE flight_seats SET status = 'AVAILABLE', booking_id = NULL
  WHERE booking_id IN (SELECT id FROM cancelled)
  RETURNING 1
)
SELECT … FROM cancelled
```

Code: `cancel()` trong `api/src/bookings/postgres/postgres-booking-repository.ts`.

## Vì sao không dùng khoá bi quan (`SELECT … FOR UPDATE` rồi UPDATE)?

Được, nhưng tốn thêm một round-trip và giữ khoá lâu hơn. Với chuyển trạng thái **một dòng**,
conditional UPDATE vừa đủ và ngắn nhất (ADR-004).

## Khi nào OCC **không** hợp

Khi phải **chọn một trong nhiều** tài nguyên. OCC thuần làm mọi người nhắm cùng một ghế rẻ
nhất, ai thua thì bị báo "hết" dù còn ghế (Day 48A C3: 15–16/20 báo sai). → xem
[04-skip-locked-va-cho-khoa.md](./04-skip-locked-va-cho-khoa.md).

## Test chứng minh

- Race test E (`postgres-booking-race.integration.test.ts`): 10 lần huỷ đồng thời một booking →
  đúng 1 `cancelled`, 9 `already-cancelled`, ghế nhả đúng một lần.
- Mutation Day 47: bỏ CTE `released` → 4 contract case + test D, E fail.

## Câu trả lời phỏng vấn 30 giây

> "Tôi không đọc rồi mới ghi. Điều kiện nằm trong `WHERE` của UPDATE, tôi đếm số dòng bị ảnh
> hưởng để biết mình thắng hay thua. Postgres tự đánh giá lại `WHERE` sau khi chờ khoá nên
> request thua match 0 dòng. Phần phụ thuộc (nhả ghế) nằm trong cùng câu bằng CTE, để chỉ người
> thắng mới chạy nó."

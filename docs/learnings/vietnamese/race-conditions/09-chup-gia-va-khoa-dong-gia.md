# 09 — Chụp giá lúc giữ ghế và khoá dòng giá

Day 49A. Code: `api/src/bookings/postgres/postgres-booking-repository.ts` (`SHARE_LOCKED_FARES`,
`toHeldSeat`), `api/src/bookings/booking-total.ts`, `api/src/money/money.ts`.
Race test: `api/tests/integration/postgres-fare-snapshot.integration.test.ts` (A, B1, B1 auto, B2, C).
Quyết định: domain-model **Decision 13**, **BR-BOOK-03**, **BR-FLT-09**; ADR-004 phụ lục Day 49A.
Note tiếng Anh (bản gốc): [money-and-price-snapshots.md](../../money-and-price-snapshots.md).

## Vấn đề

Mỗi hạng ghế có một giá (`flight_fares`). Giữ ghế thì mỗi hành khách **chép** giá hạng ghế của mình
vào `booking_passengers.price_vnd`; tổng booking suy ra từ các giá đó. Admin đổi giá sau khi giữ →
booking cũ **giữ nguyên giá**, booking mới trả giá mới.

Câu hỏi race: nếu đổi giá xảy ra **cùng lúc** với một lần giữ ghế thì sao?

1. Có thể nào một booking có ghế BUSINESS giá cũ và ghế ECONOMY giá mới không?
2. Có thể nào một booking **commit sau** khi giá mới đã có hiệu lực mà vẫn mang giá cũ không?

## Cách xử lý: đọc giá trong chính câu giữ ghế, `FOR SHARE`

```sql
WITH …, held AS (UPDATE flight_seats … RETURNING row, letter, fare_class),
     fares AS (
       SELECT fare_class, amount_vnd FROM flight_fares
       WHERE flight_id = $1
       FOR SHARE                       -- khoá chia sẻ dòng giá
     )
SELECT held.row, held.letter, held.fare_class, fares.amount_vnd
FROM held LEFT JOIN fares ON fares.fare_class = held.fare_class   -- PHẢI JOIN
```

- **Cùng một câu lệnh** → mọi ghế lấy giá từ một snapshot → câu hỏi 1 không xảy ra. (Hai câu riêng
  trong READ COMMITTED thì mỗi câu một snapshot → có thể trộn.)
- **`FOR SHARE`** → câu hỏi 2:
  - Đổi giá (`UPDATE flight_fares`) cần khoá độc quyền dòng giá → **chờ** hold đang mở commit.
    Booking commit trước, giá cũ: thứ tự tuần tự "giữ ghế rồi mới đổi giá".
  - Hold gặp dòng giá đang bị đổi mà chưa commit → **chờ**; sau đó READ COMMITTED đọc lại bản đã
    commit → lấy **giá mới** cho mọi hạng.
  - Khoá chia sẻ không chặn nhau → nhiều hold cùng chuyến **không** xếp hàng vì giá.
- `FOR SHARE OF flight` (Day 46) **không** đủ: nó xung đột với `UPDATE flights`, không phải
  `UPDATE flight_fares`.
- Ghế có hạng mà chuyến không có giá (BR-FLT-09 hỏng) → **throw**, rollback; không được biến thành
  `not-enough-seats` hay giữ ghế không có giá.

## Bẫy: CTE không ai đọc thì không chạy

Postgres chỉ chạy một CTE `SELECT` thường khi có chỗ **đọc** nó. Nếu khai báo `fares … FOR SHARE`
nhưng lấy giá bằng subquery khác (`(SELECT amount_vnd FROM flight_fares WHERE …)`), câu lệnh vẫn trả
**đúng giá** khi không có tranh chấp — nhưng **không có khoá nào**. Unit test, contract test đều
xanh. Chỉ race test B bắt được (mutation Day 49A).

## Đo được (10 lần chạy liên tiếp, đều xanh)

| Test | Kịch bản | Kết quả |
|---|---|---|
| A | đổi giá sau khi giữ | booking cũ 4,2tr + 1,5tr = 5,7tr; booking mới 5tr + 2tr = 7tr |
| A | xoá tay giá BUSINESS | hold throw `… no BUSINESS fare for seat 1A (BR-FLT-09)`, không giữ ghế, không lưu |
| B1 | cổng: transaction đổi giá chưa commit, hold [1A, 3A] | hold **chờ** (còn pending sau 50 ms), rồi lấy giá mới cả hai hạng |
| B1 auto | như trên, hệ thống tự chọn 2 ghế | chờ; 5tr + 5tr |
| B1 đối chứng | cùng câu, bỏ `FOR SHARE` | **không chờ**, lấy giá cũ |
| B2 | dừng CreateBooking ở bước ghi audit (transaction hold còn mở), rồi đổi giá | lần đổi giá **chờ**; booking commit trước, giá cũ |
| B2 đối chứng | bỏ `FOR SHARE` | đổi giá commit giữa chừng; booking commit **sau** đó mà vẫn giá cũ |
| C | 20 vòng, 2 hold đua 1 lần đổi giá (lệch 0–20 ms) | không bao giờ trộn; mỗi lần chạy 32–38 cũ / 2–8 mới trên 40 |

Mutation:

| Sửa hỏng | Test fail |
|---|---|
| Bỏ `FOR SHARE` | B1, B2 |
| Câu chỉ định ghế lấy giá bằng subquery (CTE không được đọc) | B1, B2 |
| Câu tự chọn ghế lấy giá bằng subquery | B1 auto |
| Tắt kiểm "thiếu giá" | A (thiếu giá) |
| `parseVndFromDatabase` ×100 | unit Money + 8 integration |

**C không chứng minh khoá**: bỏ `FOR SHARE` thì C vẫn xanh, vì một câu lệnh đã đọc một snapshot.
C canh **hình dạng** (một câu lệnh); khoá chỉ được chứng minh bởi test có một bên phải **chờ**.

## Cách dựng "cổng" cho race này

- **Đổi giá chưa commit**: mở `queryRunner`, `startTransaction`, chạy `UPDATE flight_fares`, giữ
  nguyên → trả về hàm commit. Kiểm hold "còn pending sau 50 ms" bằng `Promise.race` với `sleep`.
- **Hold chưa commit**: CreateBooking chạy hold → audit → outbox → commit. Truyền một
  `AuditRecorder` chờ tín hiệu → transaction hold đứng yên đúng sau câu giữ ghế.

Liên quan: [04 — SKIP LOCKED và chờ khoá](./04-skip-locked-va-cho-khoa.md) (`FOR SHARE OF flight`),
[06 — Cách test race condition](./06-cach-test-race-condition.md) (cổng, đối chứng, mutation).

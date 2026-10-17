# 08 — Hết hạn giữ ghế và biên thời gian

Day 48B. Code: `api/src/bookings/expire-holds.ts`, `booking-lifecycle.ts`,
`postgres/postgres-booking-repository.ts` (`expireDueHolds`, `cancel`, `releaseSeatsOf`).
Race test: `api/tests/integration/postgres-booking-expiry-race.integration.test.ts` (A–F).
Quyết định: domain-model **Decision 12**, **BR-BOOK-10**; ADR-004 phụ lục Day 48B.

## Vấn đề

Booking `HELD` có hạn 15 phút. Hạn trôi qua ở một thời điểm, nhưng database không tự "làm gì" ở
thời điểm đó. Ba nơi hỏi "hold này hết chưa?" và mỗi nơi cần một cách trả lời khác nhau:

| Ai hỏi | Cách | Vì sao không dùng cách khác |
|---|---|---|
| Tồn kho ghế | **Job** trả ghế (60 s, lô 50, tối đa 20 lô) | Suy ra khi đọc → mỗi lần đếm ghế phải join `bookings`, mất partial index Day 47; câu giữ ghế phải "cướp" ghế còn ghi `HELD` → hai người ghi một dòng |
| Hiển thị (GET) | **Suy ra khi đọc**: `HELD` + hạn `<= now` → `EXPIRED` | Không ai ghi giá trị hiển thị → suy ra là rẻ và luôn đúng (giống `CLOSED` của flight) |
| Quyết định (huỷ, thanh toán) | **Kiểm hạn trong `WHERE`** của chính câu UPDATE | Nếu tin job: huỷ 10 s sau hạn sẽ là "huỷ" hay "hết hạn" tuỳ timer 60 s đã chạy chưa |

## Biên thời gian bổ sung (BR-BOOK-10)

```text
hold_expires_at <= now   → đã hết hạn   (job quét)
hold_expires_at >  now   → còn hiệu lực (huỷ, thanh toán)
```

Không thời điểm nào thuộc cả hai phía hay không thuộc phía nào. Viết đúng một lần trong TS
(`isHoldLapsed`), một lần trong mỗi câu SQL, và **test đúng tại thời điểm hạn**: contract chạy cả
"huỷ đúng lúc hạn → `expired`" và "job quét đúng lúc đó → lấy được". Test cách hạn 1 phút không
phân biệt được `<` với `<=`.

## Ba race và cách xử lý

### 1. Nhiều sweeper cùng lúc (nhiều instance API) — test A, B

```sql
SELECT id FROM bookings
WHERE status = 'HELD' AND hold_expires_at <= $now
ORDER BY hold_expires_at, id LIMIT $n
FOR UPDATE SKIP LOCKED
```

- `SKIP LOCKED`: booking đang bị người khác khoá (huỷ, sweeper khác) → bỏ qua, lần sau lấy.
- **Bỏ `SKIP LOCKED` vẫn đúng** (sweeper chờ, re-check `status = 'HELD'` trên dòng đã commit, thấy
  `EXPIRED` → bỏ) — nhưng **xếp hàng**. Đo: có `SKIP LOCKED` ~250 ms, 12–13 cặp batch chạy chồng
  nhau; không có ~910 ms, 0 cặp chồng.
- Mỗi lô một transaction: đổi status + nhả ghế + 1 audit + 1 outbox mỗi booking. Lô lỗi rollback
  cả lô (test F), lô trước vẫn giữ, lần chạy sau thử lại.

### 2. Huỷ vs hết hạn cùng lúc — test C

- Huỷ: `WHERE status = 'HELD' AND hold_expires_at > $now` (hoặc `CONFIRMED`).
- Hết hạn: `WHERE status = 'HELD' AND hold_expires_at <= $now`.
- Cùng `now` → chỉ một điều kiện đúng. Đúng lúc hạn: job thắng **20/20 vòng**, huỷ trả `expired`
  (`409 BOOKING_EXPIRED`, không ghi gì).
- Đồng hồ lệch (huỷ đọc hạn − 1 ms): cả hai có thể khớp snapshot; row lock cho một người qua,
  người kia re-check và không khớp → **đúng một kết thúc** mỗi booking (đo: 16/4, 20/0, 19/1…).

### 3. Nhả ghế vs giữ ghế chỉ định — test E (thứ tự khoá)

- Giữ ghế chỉ định khoá ghế theo (row, letter) **bất kể trạng thái** (CTE `locked` không lọc status).
- Huỷ cũ nhả ghế bằng `UPDATE … WHERE booking_id` → khoá theo thứ tự quét. Hold giữ 12A chờ 12B,
  release giữ 12B chờ 12A → **deadlock `40P01`**.
- Sửa: khoá trước `ORDER BY flight_id, row, letter FOR UPDATE` rồi mới update đúng những dòng đó.
  Huỷ và job dùng chung (`releaseSeatsOf`).

**Test được nhờ "cổng"**: một câu lệnh đơn chạy quá nhanh, hold không bao giờ kịp chen vào. Test E
giữ khoá 12A ở transaction thứ ba → hold tới xếp hàng ở 12A → release tới sau → mở cổng:

| Release | Kết quả |
|---|---|
| Đối chứng: khoá 12B trước 12A | deadlock **5/5** |
| Code thật (12A trước) | 0 deadlock; release xếp hàng sau hold mà không giữ gì; hold thấy ghế còn `HELD` → `seats-unavailable`, rồi release chạy |

Mutation đổi `ORDER BY` thành `DESC` → cả hai test thật fail với `40P01`. Bỏ hẳn `ORDER BY` → vẫn
xanh (thứ tự vật lý tình cờ là (row, letter)) — giống Day 48A: **`ORDER BY` là lời hứa, plan thì không**.

### Thêm: job trả ghế vs người đặt ghế đó — test D

Chuyến 1 ghế, hold vừa hết hạn, cùng lúc job quét và người mới đặt. Người mới hoặc lấy được ghế,
hoặc `NOT_ENOUGH_SEATS` (auto hold `SKIP LOCKED` bỏ qua ghế job đang khoá). Đo: hầu như luôn bị từ
chối — đúng (BR-SEAT-01 giữ), ghế trống ngay sau đó. Không bao giờ hai booking một ghế.

## Bất biến mỗi test kết thúc

- Không ghế nào còn thuộc booking đã kết thúc (`EXPIRED`, `CANCELLED`).
- Số ghế `HELD` = số hành khách của các booking `HELD`.
- Mỗi booking có **đúng một** audit kết thúc (`BOOKING_EXPIRED` hoặc `BOOKING_CANCELLED`).

## Câu trả lời phỏng vấn 30 giây

> "Hết hạn giữ ghế tôi tách theo người hỏi: job trả ghế cho tồn kho, đọc thì suy ra `EXPIRED`, còn
> huỷ và thanh toán tự kiểm hạn trong `WHERE`. Biên là `<=` cho hết hạn và `>` cho còn hiệu lực,
> test đúng tại mili-giây đó. Job dùng `SKIP LOCKED` theo lô nên chạy nhiều instance được — tôi đo
> bỏ nó vẫn đúng nhưng xếp hàng chậm gần 4 lần. Khi phân tích tôi phát hiện nhả ghế không theo thứ
> tự khoá có thể deadlock với giữ ghế chỉ định; tôi tái hiện 5/5 bằng một transaction làm cổng, rồi
> sửa bằng CTE khoá có `ORDER BY` dùng chung cho huỷ và hết hạn."

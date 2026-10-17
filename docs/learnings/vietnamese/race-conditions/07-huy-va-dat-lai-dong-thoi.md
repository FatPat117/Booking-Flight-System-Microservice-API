# 07 — Huỷ và đặt lại đồng thời

Race test D và E của Day 47 (`api/tests/integration/postgres-booking-race.integration.test.ts`).

## Kịch bản D — huỷ đua với đặt mới trên chuyến đã đầy

Chuyến 5 ghế, đã có 5 booking. Cùng lúc:
- người A huỷ booking của mình (nhả 1 ghế);
- người B đặt booking mới.

Hai kết cục đều **hợp lệ**:
1. B chạy sau khi A commit → B lấy được ghế vừa nhả (`created`).
2. B chạy khi A còn giữ khoá ghế → `SKIP LOCKED` bỏ qua ghế đó → B nhận `not-enough-seats`.

Cái **không được** xảy ra: hai booking cùng trên một ghế, hoặc ghế `AVAILABLE` mà vẫn có booking.

### Vì sao an toàn

- Huỷ là **một câu SQL hai CTE**: đổi trạng thái booking và nhả ghế trong cùng một câu (file
  [01](./01-occ-conditional-update.md)). Không có khoảnh khắc "booking đã huỷ nhưng ghế chưa nhả"
  để người khác nhìn thấy.
- Đặt mới khoá ghế bằng `FOR UPDATE … SKIP LOCKED`: không bao giờ lấy ghế đang bị transaction
  huỷ giữ.
- `CHK_flight_seats_booking`: `(status = 'AVAILABLE') = (booking_id IS NULL)` — DB chặn trạng thái
  nửa vời.

### Bài học về test: stagger

Phiên bản đầu không trễ → 20/20 vòng B đều `not-enough-seats` — chỉ một thứ tự được chạy, test
không phủ trường hợp 1. Sửa: trễ B 0/1/2/4/8 ms xoay vòng → mỗi lần chạy có 8–11 vòng đặt lại
được, 9–12 vòng hết ghế. Test assert bất biến cho **cả hai** kết cục:

```text
created         → 5 booking active, 0 ghế trống
not-enough-seats → 4 booking active, 1 ghế trống
và luôn: số ghế giữ = số booking giữ, mỗi ghế giữ thuộc đúng một booking
```

## Kịch bản E — 10 lần huỷ đồng thời một booking

Kết quả: đúng 1 `cancelled`, 9 `already-cancelled`, ghế nhả **đúng một lần**.

Người thua chờ khoá dòng booking, Postgres đánh giá lại `WHERE status IN ('HELD','CONFIRMED')` trên
phiên bản mới (`CANCELLED`) → 0 dòng → CTE nhả ghế cũng không chạy (nó chỉ nhả cho dòng mà CTE
`cancelled` trả về).

Mutation Day 47: bỏ CTE `released` (nhả ghế bằng câu riêng) → 4 contract case + D + E fail.

## Liên quan tới Day 48B

Job hết hạn (`HELD → EXPIRED`) đua với huỷ và (sau này) với thanh toán — cùng mẫu: điều kiện
trạng thái trong `WHERE` của câu đổi trạng thái, nhả ghế trong cùng câu, và nhả nhiều ghế thì theo
thứ tự (row, letter). Từ Day 48B câu huỷ còn kiểm `hold_expires_at > now` và khoá ghế theo thứ tự
trước khi nhả → xem [08](./08-het-han-giu-ghe-va-bien-thoi-gian.md).

## Câu trả lời phỏng vấn 30 giây

> "Huỷ và nhả ghế là một câu SQL nên không ai thấy trạng thái nửa vời. Người đặt mới dùng
> `SKIP LOCKED` nên hoặc lấy được ghế vừa nhả, hoặc nhận hết ghế — cả hai đều đúng. Test của tôi
> phải thêm độ trễ xoay vòng vì không có nó chỉ một thứ tự được chạy, và tôi assert bất biến cho
> cả hai kết cục."

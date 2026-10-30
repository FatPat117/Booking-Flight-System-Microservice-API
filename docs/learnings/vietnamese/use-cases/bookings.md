# Use case: booking

## CreateBooking — `POST /api/flights/:flightId/bookings` (role `user`)

**Code:** `api/src/bookings/create-booking.ts`, `booking-validation.ts`,
`postgres/postgres-booking-repository.ts` (`holdAutoSeats`, `holdChosenSeats`, `insertBooking`)

**Input** (từ Day 48A):
```json
{ "passengers": [ { "name": "Bob Tran", "seat": "12A" }, { "name": "Lan Tran", "seat": "12B" } ] }
```
Hoặc không ghế nào: `{ "passengers": [ { "name": "Bob" }, { "name": "Lan" } ] }` → hệ thống chọn.

**Validation theo thứ tự:**
1. Không phải object → `INVALID_BODY`.
2. Có `passengerName` (body cũ) → `UNSUPPORTED_FIELD`.
3. Không phải mảng 1–9 → `INVALID_PASSENGER_COUNT` — **dừng ngay**, không đọc từng hành khách.
4. Từng hành khách: `INVALID_PASSENGER`, `REQUIRED` (tên), `INVALID_SEAT` (mã như `12A`).
5. Người có ghế người không → `MIXED_SEAT_SELECTION` (BR-BOOK-09).
6. Ghế lặp → `DUPLICATE_SEAT` (BR-BOOK-02).

Kết quả validate là kiểu `{ seatSelection: "auto" } | { seatSelection: "chosen" }`.

**Luồng (một transaction):**
1. Sinh `bookingId` **trước**.
2. `holdSeats(flightId, bookingId, auto n | chosen [ghế], now)` — **một câu SQL**, tất cả hoặc không:
   - auto: `SKIP LOCKED`, `LIMIT n`, `WHERE enough.ok`;
   - chosen: khoá theo `(row, letter)`, `WHERE verdict.ok` (đủ số + tất cả `AVAILABLE`).
   - **Day 49A**: cùng câu đó đọc giá của chuyến `FOR SHARE` (CTE `fares`, phải JOIN) → mỗi ghế
     giữ được trả về kèm `fareClass` + `price`. Ghế có hạng không có giá → **throw** (BR-FLT-09 hỏng).
   Không `held` → trả outcome luôn, **không ghi gì**.
3. Ghép ghế (kèm giá) với hành khách theo chỉ số (số ghế ≠ số khách → throw, là bug adapter).
4. Tạo booking `HELD`, `holdExpiresAt = now + 15 phút`, mỗi hành khách lưu `fare_class` +
   `price_vnd`; `total` = tổng giá (suy ra, không lưu). Vòng sinh mã đặt chỗ tối đa 5 lần
   (`ON CONFLICT DO NOTHING` → `reference-taken` → sinh lại). Quá 5 → throw.
5. Audit `BOOKING_CREATED` (reference, passengerCount, seats `"1A,1B"`, `totalVnd`, holdExpiresAt — không tên).
6. Outbox `booking-held` (Day 49A thêm `fareClass`/`price` mỗi hành khách và `total`, optional trong parser).

**Outcome → HTTP:**
| Outcome | HTTP |
|---|---|
| `created` | 201 + `Location: /api/bookings/:id` |
| `validation_failed` | 422 `VALIDATION_FAILED` |
| `flight-not-found` (gồm id sai định dạng) | 404 `FLIGHT_NOT_FOUND` |
| `not-enough-seats` | 409 `NOT_ENOUGH_SEATS` |
| `seats-unavailable` | 409 `SEATS_UNAVAILABLE`, `details` = mã ghế bị cản (không nói ai giữ) |
| `unknown-seats` | 422, `details[].code = UNKNOWN_SEAT` |
| `sales-closed` (chưa OPEN, huỷ, hoặc còn ≤ 1 giờ) | 409 `SALES_CLOSED` |

Admin đặt vé → 403 (BR-AUTH-03: admin không đặt hộ).

**Xử lý hay:** half-commit bị chặn bằng phán quyết trong `WHERE`; deadlock bị chặn bằng thứ tự
khoá; FK deferred cho phép ghế trỏ tới booking chưa tồn tại tới lúc COMMIT. Xem
[../race-conditions/05-giu-nhieu-ghe-tat-ca-hoac-khong.md](../race-conditions/05-giu-nhieu-ghe-tat-ca-hoac-khong.md).
Chụp giá vs đổi giá đồng thời: [../race-conditions/09-chup-gia-va-khoa-dong-gia.md](../race-conditions/09-chup-gia-va-khoa-dong-gia.md).

**Response mẫu** (chuyến 2 hạng, Day 49A):
```json
{ "id": "…", "reference": "K7Q4PZ", "flightId": "…", "ownerAccountId": "…", "status": "HELD",
  "createdAt": "…", "holdExpiresAt": "…+15m",
  "passengers": [
    { "name": "Bob Tran", "seat": "1A", "fareClass": "BUSINESS", "price": { "amount": 4200000, "currency": "VND" } },
    { "name": "Lan Tran", "seat": "3A", "fareClass": "ECONOMY", "price": { "amount": 1500000, "currency": "VND" } } ],
  "total": { "amount": 5700000, "currency": "VND" } }
```
Giá **không đổi** khi admin đổi giá sau đó (BR-BOOK-03). GET theo id, theo mã, và danh sách trả
cùng giá + tổng; danh sách vẫn **3 query** (giá nằm trên dòng hành khách). Booking có trước Day 49A
mang giá **lúc chạy migration**.

## CancelBooking — `DELETE /api/bookings/:id` (role `user`, chủ sở hữu)

**Code:** `api/src/bookings/cancel-booking.ts`, `cancel()` trong repository

- id sai định dạng → 404.
- `now` đọc **một lần** trước transaction (Day 48B), dùng cho cả quyết định lẫn thời gian audit.
- Transaction: **một câu SQL** — `cancelled` (`UPDATE … WHERE id AND (status = 'CONFIRMED' OR (status = 'HELD' AND hold_expires_at > $now))` + scope chủ sở hữu), rồi `locked` (khoá ghế `ORDER BY flight_id, row, letter`) và `released` (nhả **mọi** ghế đã khoá). Chỉ người thắng mới nhả ghế.
- 0 dòng → câu đọc phụ (**cũng có scope**) phân loại qua `classifyNotCancelled`: không có → `not-found`; `CANCELLED` → `already-cancelled`; `EXPIRED` hoặc `HELD` quá hạn → `expired`; còn huỷ được mà không khớp → **throw** (SQL và luật lệch nhau là bug).
- Audit `BOOKING_CANCELLED`, outbox `booking-cancelled`.

| Outcome | HTTP |
|---|---|
| `cancelled` | 204 |
| `already-cancelled` | 409 `BOOKING_ALREADY_CANCELLED` (cố ý, để phân biệt lần đầu với lần lặp) |
| `expired` (hold đã quá hạn, job quét hay chưa đều vậy; không ghi gì) | 409 `BOOKING_EXPIRED` |
| `not-found` (gồm booking của người khác, kể cả đã quá hạn) | 404 `BOOKING_NOT_FOUND` |

`HELD` huỷ được **tới khi hết hạn** (BR-BOOK-10: còn hiệu lực khi `hold_expires_at > now`); đúng
thời điểm hạn là đã hết. Luật 24 giờ cho `CONFIRMED` (BR-BOOK-06) chưa làm (bước 7).
Admin huỷ → 403 (admin chỉ huỷ qua huỷ chuyến bay, sau này).
Sau huỷ, hành khách vẫn giữ bản sao mã ghế làm lịch sử.

## GetBooking — `GET /api/bookings/:id`

- User chỉ thấy booking của mình, admin thấy tất cả (`BookingAccessScope`).
- Của người khác, không tồn tại, id sai định dạng → **cùng một** 404 `BOOKING_NOT_FOUND`.
- **Trạng thái hiệu lực** (Day 48B, cả 3 use case đọc): `HELD` mà `hold_expires_at <= now` trả về
  `EXPIRED` dù dòng trong DB còn `HELD` (`withEffectiveStatus`, nhận `getCurrentTime`). List dùng
  một `now` cho cả trang.

## GetBookingByReference — `GET /api/bookings/by-reference/:reference`

**Code:** `api/src/bookings/get-booking-by-reference.ts`

- Mã sai định dạng (`isBookingReference`: 6 ký tự `A-HJ-NP-Z2-9`, chữ thường bị từ chối) → 404 **không chạm DB**.
- Cùng luật scope như GetBooking. Lý do: mã 6 ký tự dễ đoán hơn UUID, an toàn đến từ scope chứ không từ sự bí mật của mã.

## ListBookings — `GET /api/bookings?page=&pageSize=`

- Cùng luật phân trang như flights; mới nhất trước.
- User: chỉ của mình; admin: tất cả.
- Hành khách của **cả trang** lấy bằng **một** query (`WHERE booking_id IN (…)`) → luôn 3 câu SQL
  mỗi trang dù trang 1 hay 10 booking (có test đếm query, chống N+1).
- Index `idx_bookings_owner_created (owner_account_id, created_at DESC, id DESC)` khớp đúng query.

## Lifecycle booking

```text
— → HELD (đặt)        HELD → CANCELLED (huỷ, khi hold > now)       CONFIRMED → CANCELLED (huỷ, booking cũ)
HELD → EXPIRED (job, khi hold <= now; đọc thì thấy EXPIRED ngay từ lúc hạn)
HELD → CONFIRMED (thanh toán thành công, Day 49B; khi hold > now ở pha 3)
```
Booking cũ được migrate `active → CONFIRMED`, `cancelled → CANCELLED`.

## ExpireHolds — job, không có route (Day 48B)

**Code:** `api/src/bookings/expire-holds.ts`, `expireDueHolds()` trong repository, job
`api/src/jobs/booking-hold-expiry-job.ts`.

- `now` đọc **một lần mỗi lần chạy**; tối đa 20 lô × 50; dừng khi một lô trả về ít hơn 50.
- Mỗi lô một transaction: `due` (`FOR UPDATE SKIP LOCKED`, theo `hold_expires_at, id`, dùng
  `idx_bookings_held_expiry`) → `expired` → `locked` / `released` (nhả ghế theo thứ tự) → mỗi
  booking một audit `BOOKING_EXPIRED` (actor `system/booking-hold-expiry`) + một outbox
  `booking-expired`.
- Kết quả `{ expired, batches, exhausted }`; `exhausted` = chạm 20 lô → log warn
  `booking_hold_expiry_backlog`.
- Lô lỗi → rollback cả lô, lô trước vẫn giữ, lần sau thử lại (head-of-line như outbox relay).

## PayForBooking — `POST /api/bookings/:id/payments` (Day 49B)

**Code:** `api/src/payments/pay-for-booking.ts`, route trong `api/src/app.ts`, validation
`api/src/payments/payment-validation.ts`, response lưu kèm key `api/src/payments/payment-response.ts`.

**Input:** header `Idempotency-Key` (1–255 ký tự ASCII hiển thị) + body
`{ paymentMethodToken, amount: { amount, currency: "VND" } }`. Route validate **trước** khi claim key
(lỗi validate không chiếm key), tính fingerprint từ `POST` + path + body đã validate.

**Luồng ba pha:**

```text
Pha 1 (tx)   claim key ─┬─ đã COMPLETED, cùng fingerprint → phát lại response đã lưu (+ Idempotent-Replayed)
                        ├─ khác fingerprint                → 422 IDEMPOTENCY_KEY_REUSED
                        └─ IN_PROGRESS                      → 409 IDEMPOTENCY_KEY_IN_PROGRESS
             đọc booking (scope chủ)  không thấy            → lưu 404
             không HELD / còn ≤ 60 s                         → lưu 409 BOOKING_NOT_PAYABLE
             amount ≠ total                                  → 422 PAYMENT_AMOUNT_MISMATCH (release key)
             INSERT payment PROCESSING ─ đã có PROCESSING    → 409 PAYMENT_IN_PROGRESS (release key)
             gắn payment vào key
Pha 2        gateway.charge (không transaction)  ─ unknown (timeout, Day 49C) → 202 PROCESSING, KHÔNG lưu, key IN_PROGRESS
                                                 ─ throw → payment ở lại PROCESSING, key IN_PROGRESS
Pha 3 (tx)   SettlePayment (dùng chung với job đối soát, Day 49C):
             declined  → FAILED, audit PAYMENT_FAILED, lưu 402
             charged   → confirmHold thắng → SUCCEEDED, audit BOOKING_CONFIRMED, outbox booking-confirmed, lưu 201
                         confirmHold thua  → REFUND_PENDING (đến hạn ngay), lưu 409 → job đối soát hoàn tiền
```

| Outcome | HTTP | Lưu vào key? |
|---|---|---|
| confirmed | `201` `{ payment, booking }` | có |
| processing — gateway không rõ (Day 49C) | `202` `{ payment }` (`PROCESSING`) | **không** — key giữ `IN_PROGRESS`, gửi lại sau khi đối soát nhận câu trả lời cuối |
| declined | `402 PAYMENT_DECLINED` | có |
| not-payable / thua race (job hoàn tiền sau) | `409 BOOKING_NOT_PAYABLE` | có |
| not-found / booking người khác | `404 BOOKING_NOT_FOUND` | có |
| key-reused / key-in-progress | `422` / `409` | không |
| amount-mismatch / payment-in-progress | `422` / `409` | không (key được release) |
| lỗi validate / admin / 5xx | `422` / `403` / `500` | không |

- Simulator: `tok_success` trừ tiền, `tok_decline` (và token lạ) bị từ chối. `PAYMENT_SIMULATOR_DELAY_MS`
  làm chậm mỗi charge **và** refund — dùng để xem race bằng tay.
- Trả được sau khi chuyến đóng bán (BR-PAY-06): không pha nào đọc trạng thái chuyến.
- Không có `Location`, không có `GET` payment (chưa có user story). Từ Day 49C, khách nhận `202` thì
  **gửi lại cùng key** để lấy kết quả cuối — đó chính là cách "đọc" payment.
- Token lỗi của simulator (Day 49C): `tok_timeout_before_charge`, `tok_lost_response`,
  `tok_refund_fails_twice`, `tok_refund_fails_permanently`; timeout `PAYMENT_GATEWAY_TIMEOUT_MS`.

## ReconcilePayments — job, không có route (Day 49C)

**Code:** `api/src/payments/reconcile-payments.ts`, `settle-payment.ts`, job
`api/src/jobs/payment-reconciliation-job.ts`.

| Payment đến hạn | Gateway trả | Kết quả |
|---|---|---|
| `PROCESSING` | succeeded (charge lại cùng id) | `SettlePayment`: còn hạn → `CONFIRMED` + key `201`; hết hạn → `REFUND_PENDING` + key `409` |
| `PROCESSING` | declined | `FAILED`, key `402` |
| `PROCESSING` | unknown | giữ `PROCESSING`, thử lại sau 1, 2, 4 … (tối đa 10) phút, warn từ lần 3 |
| `REFUND_PENDING` | refunded | `REFUNDED`, audit `PAYMENT_REFUNDED` |
| `REFUND_PENDING` | failed retryable / unknown, < 5 lần | thử lại sau 1, 2, 4, 8 phút |
| `REFUND_PENDING` | failed không retryable, hoặc lần 5 | `REFUND_FAILED`, audit `PAYMENT_REFUND_FAILED`, log error `payment_refund_needs_attention` |

Actor: `system/payment-reconciliation`. Payment ném lỗi (vd. request vừa settle trước) → log
`payment_reconciliation_failed`, bỏ qua, lease đưa nó quay lại sau.

## CleanupIdempotencyKeys — job, không có route (Day 49C)

Xoá key `COMPLETED` có `created_at` cũ hơn 24 h, lô 500, tối đa 20 lô/lượt; **không bao giờ** xoá key
`IN_PROGRESS`. Gửi lại request sau khi key bị xoá → request mới → booking `CONFIRMED` trả
`409 BOOKING_NOT_PAYABLE`, không trừ tiền (BR-PAY-10).


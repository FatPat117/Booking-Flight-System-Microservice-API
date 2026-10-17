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
   Không `held` → trả outcome luôn, **không ghi gì**.
3. Ghép ghế với hành khách theo chỉ số (số ghế ≠ số khách → throw, là bug adapter).
4. Tạo booking `HELD`, `holdExpiresAt = now + 15 phút`; vòng sinh mã đặt chỗ tối đa 5 lần
   (`ON CONFLICT DO NOTHING` → `reference-taken` → sinh lại). Quá 5 → throw.
5. Audit `BOOKING_CREATED` (reference, passengerCount, seats `"1A,1B"`, holdExpiresAt — không tên).
6. Outbox `booking-held`.

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

**Response mẫu:**
```json
{ "id": "…", "reference": "K7Q4PZ", "flightId": "…", "ownerAccountId": "…", "status": "HELD",
  "createdAt": "…", "holdExpiresAt": "…+15m",
  "passengers": [ { "name": "Bob Tran", "seat": "12A" }, { "name": "Lan Tran", "seat": "12B" } ] }
```

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
Chưa có: HELD → CONFIRMED (thanh toán, bước 6)
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

# 10 — Thanh toán ba pha, hoàn tiền khi thua race, Idempotency-Key

Day 49B. Code: `api/src/payments/pay-for-booking.ts` (`createPayForBooking`),
`api/src/bookings/postgres/postgres-booking-repository.ts` (`confirmHold`, `updateSeatsOf`),
`api/src/payments/postgres/postgres-payment-repository.ts`,
`api/src/idempotency/postgres/postgres-idempotency-repository.ts`.
Race test: `api/tests/integration/postgres-payment-race.integration.test.ts` (A, B, C, D, C-đúng-hạn, E).
Quyết định: domain-model **Decision 14**, **BR-PAY-01..07**; **ADR-009**.
Note tiếng Anh (bản gốc): [payments-and-idempotency-keys.md](../../payments-and-idempotency-keys.md).

## Vấn đề

Trả tiền = gọi một hệ thống **khác** (gateway) ở giữa một lần ghi. Ba loại race:

1. **Cùng một request gửi hai lần** (mạng chập chờn, double click) → trừ tiền hai lần.
2. **Hai request khác nhau cho cùng booking** (hai tab, hai key) → hai payment thành công.
3. **Booking hết hạn hoặc bị huỷ trong lúc gateway đang trừ tiền** → tiền đã mất mà booking không còn.

## Cách xử lý

### Ba pha, gateway ở ngoài transaction

```text
Pha 1 (tx ngắn)  claim key → đọc booking (owner, HELD, còn > 60 s, amount = total)
                 → INSERT payment PROCESSING → gắn payment vào key            COMMIT
Pha 2 (không tx) gateway.charge(paymentId, amount, token)          ← không khoá gì
Pha 3 (tx ngắn)  confirmHold: UPDATE bookings … WHERE status='HELD' AND hold_expires_at > now
                 → ghế HELD → BOOKED (cùng câu) → payment SUCCEEDED → outbox
                 → lưu response vào key                                         COMMIT
```

Race 3 được quyết định **ở pha 3** bằng đúng điều kiện của huỷ (BR-BOOK-10, `> now`). Huỷ và job
hết hạn **không cần biết gì** về thanh toán: dòng booking cho đúng một người đi qua.

### Thua race → hoàn tiền, ghi ý định trước

```text
confirmHold không khớp dòng nào
  → payment REFUND_PENDING, lưu 409 BOOKING_NOT_PAYABLE vào key     COMMIT
  → gateway.refund(...)                                              (ngoài tx)
  → payment REFUNDED, audit actor system/payment-refund              (tx ngắn)
```

Vì sao `REFUND_PENDING` **trước** refund: crash ngay sau commit vẫn còn một dòng nói "khoản này
phải hoàn" → đối soát (49C) làm tiếp. Làm ngược (refund rồi mới ghi) mà crash giữa chừng → tiền đã
trả lại nhưng DB vẫn nói payment còn nguyên, không gì chỉ tới nó.

Biên 60 s (BR-PAY-07): pha 1 chỉ cho bắt đầu khi `hold_expires_at > now + 60 s` → thua race hiếm.

### Idempotency-Key (race 1)

- Claim = `INSERT … ON CONFLICT DO NOTHING` trên `(account_id, operation, key)`. Claim thứ hai
  gặp dòng **chưa commit** thì **chờ** transaction đầu; commit → thấy `IN_PROGRESS` → `409`;
  rollback → claim được. Không có `23505` → transaction không bị abort.
- Fingerprint = SHA-256 của `{ method, path, body đã validate }` (key sắp xếp). Cùng key khác
  fingerprint → `422 IDEMPOTENCY_KEY_REUSED`.
- Response cuối cùng lưu **cùng transaction** với kết quả nghiệp vụ → key `COMPLETED` không bao giờ
  lệch với dữ liệu. Lưu bằng `json` (không phải `jsonb`) để phát lại **từng byte**.

### Partial unique index (race 2)

```sql
CREATE UNIQUE INDEX … ON payments (booking_id) WHERE status = 'PROCESSING';
CREATE UNIQUE INDEX … ON payments (booking_id) WHERE status = 'SUCCEEDED';   -- BR-PAY-05

INSERT INTO payments … ON CONFLICT ("booking_id") WHERE "status" = 'PROCESSING' DO NOTHING
```

Lặp lại predicate trong `ON CONFLICT` để Postgres chọn đúng partial index làm "trọng tài". Trùng →
`INSERT 0 0`, không lỗi → trả `409 PAYMENT_IN_PROGRESS`, release key.

## Đo được (file chạy 10 lần liên tiếp, 10/10 xanh)

| Test | Kịch bản | Kết quả |
|---|---|---|
| A | 10 request cùng key, charge chậm 200 ms | **1** charge; 1×`201`, 9×`409 IDEMPOTENCY_KEY_IN_PROGRESS` |
| B | 5 key khác nhau, cùng booking, 10 vòng | mỗi vòng đúng 1 `SUCCEEDED`; tổng `201 ×10, PAYMENT_IN_PROGRESS ×40`; charges = succeeded + refunds |
| C | cổng trong `charge`; job hết hạn chạy trong lúc chờ | job **không bị chặn**, booking `EXPIRED`, payment `REFUNDED` |
| D | như C nhưng chủ booking huỷ | huỷ mất **2–4 ms**, booking `CANCELLED`, payment `REFUNDED` |
| C đúng hạn | pha 3 ở hạn − 1 ms, job ở hạn, cùng lúc, 20 vòng | 17–19 confirm thắng / 1–3 expire thắng + hoàn tiền; mỗi booking **một** kết cục |
| E (đối chứng) | gateway **trong** transaction (`SELECT … FOR UPDATE`, chờ 1 s) | huỷ chờ **908–922 ms**; job `SKIP LOCKED` **bỏ qua** booking (0 expired); ba pha: huỷ **2–11 ms** |

Bất biến cuối mỗi test: ghế `HELD` ⇔ booking `HELD`, ghế `BOOKED` ⇔ booking `CONFIRMED`; booking
đã kết thúc không còn ghế. **Không bao giờ** `CONFIRMED` mà ghế `AVAILABLE`.

## Bẫy

- **`jsonb` đổi thứ tự key** → "phát lại" khác từng byte. Contract test dùng `deepEqual` nên không
  thấy; e2e so byte mới bắt được. Giờ cột là `json`, test so `JSON.stringify`.
- **Fingerprint phải có path**: race test B lúc đầu dùng lại key `key-b0` giữa các vòng với cùng
  fingerprint → vòng sau nhận `201 replayed` của booking vòng trước.
- **Gateway lỗi không rõ kết quả**: **không** release key (retry có thể trừ tiền lần hai); payment
  ở lại `PROCESSING`, key `IN_PROGRESS` đến khi 49C đối soát.
- **Thứ tự khoá ở pha 3**: booking → ghế (cùng CTE `updateSeatsOf` với huỷ/hết hạn, theo
  `(flight_id, row, letter)`) → payment → key. Khoá booking trước chỉ xếp hàng confirm với huỷ;
  với giữ ghế chỉ định thì **thứ tự khoá ghế** mới là thứ gỡ vòng chờ.

## Câu hỏi tự kiểm tra

1. Vì sao không gọi gateway trong transaction? Kể hai hậu quả đo được.
2. Huỷ và job hết hạn có cần biết payment đang chạy không? Vì sao?
3. Idempotency-Key chặn được race nào trong ba race ở trên, và cái gì chặn race còn lại?
4. Vì sao amount sai **không** lưu vào key, còn `409 BOOKING_NOT_PAYABLE` thì có?

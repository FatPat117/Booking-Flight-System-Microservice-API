# 12 — Đổi ghế, huỷ booking đã trả tiền, và snapshot của một câu lệnh

Day 50. Code: `api/src/bookings/postgres/postgres-booking-repository.ts` (`changeSeatInTransaction`,
`cancelInTransaction`), `api/src/bookings/change-seat.ts`, `api/src/bookings/cancel-booking.ts`.
Test: `api/tests/integration/postgres-seat-change-race.integration.test.ts` (A, A', B, C, C forced, C', D, E, F),
`api/tests/integration/invariants.ts` (hàm bất biến toàn cục) + `invariants.integration.test.ts`.
Quyết định: domain-model **Decision 16**, **BR-BOOK-06/07**.

## Vấn đề

1. **Hoán đổi chéo**: A đổi `12A → 14C`, B đổi `14C → 12A` cùng lúc. Khoá "ghế của mình trước" →
   A giữ 12A chờ 14C, B giữ 14C chờ 12A → vòng → Postgres giết một bên (`40P01`).
2. **Đổi ghế vs giữ ghế mới** trên cùng ghế đích: không được để một ghế có hai chủ.
3. **Huỷ vs đổi ghế cùng booking**: booking đã huỷ không được còn giữ ghế nào.
4. **Huỷ booking đã trả tiền**: tiền phải được hoàn, **nguyên tử** với việc huỷ.

## Lời giải

- Đổi ghế = một transaction, khoá theo thứ tự toàn cục: flight `FOR SHARE` + booking `FOR UPDATE`,
  rồi **cả hai ghế cùng lúc** `ORDER BY row, letter FOR UPDATE` (không phân biệt ghế nào là "của
  mình"), đọc trạng thái + hạng ghế đích **dưới khoá**, rồi mới ghi.
- Huỷ `CONFIRMED`: mốc `departure_at − 24h > now` nằm trong câu huỷ; payment `SUCCEEDED →
  REFUND_PENDING` trong **cùng transaction**; job đối soát (Day 49C) hoàn tiền. Request huỷ không gọi gateway.

## Lỗi race test tìm ra — snapshot của câu lệnh (quan trọng)

READ COMMITTED: mỗi câu lệnh đọc **snapshot chụp lúc nó bắt đầu**. Câu huỷ cũ (Day 48B) là **một
câu**: `UPDATE bookings` rồi tìm ghế theo `booking_id` **trong snapshot đó**.

```
1. đổi ghế khoá booking, chuyển 3A → 9F (chưa commit)
2. câu huỷ bắt đầu  ← snapshot: booking còn ở 3A, 9F trống; UPDATE chờ khoá booking
3. đổi ghế commit
4. câu huỷ lấy khoá → CANCELLED ✓, nhưng tìm ghế trên snapshot cũ → chỉ thấy 3A (đã trống)
   → 9F vẫn BOOKED cho booking đã huỷ ❌
```

Sửa: huỷ khoá booking bằng **một câu riêng trước** (cùng điều kiện huỷ được), rồi mới chạy câu huỷ
— câu sau có snapshot mới, thấy ghế mới. Lần sửa đầu khoá **vô điều kiện** → làm hỏng race test C
của Day 48B: job hết hạn (`SKIP LOCKED`) bỏ qua booking đang bị một lần huỷ sẽ-trả-`expired` khoá.
Bản cuối chỉ khoá booking **sẽ thật sự huỷ**.

Bài học: **tính năng mới làm lộ giả định cũ** ("ghế của booking không đổi trong lúc huỷ"). Chỉ race
test xuyên tính năng mới bắt được.

## Bằng chứng (10 lần chạy liên tiếp)

| Test | Kết quả |
|---|---|
| A — hoán đổi chéo có gate | 0 deadlock, 20/20 `seat-unavailable` |
| A' — khoá "ghế của mình trước" | **5/5 deadlock** |
| B — đổi ghế vs giữ ghế | đúng một bên thắng |
| C — huỷ vs đổi ghế | cả hai thứ tự đều xảy ra, không ghế nào thuộc booking đã huỷ |
| C forced / C' | bản sửa nhả ghế mới; câu huỷ một-câu để lại 9F `BOOKED` |
| F — 10 lần huỷ đã trả tiền + 2 job đối soát | 10 lần hoàn tiền, mỗi payment đúng 1 lần |

Mutation: bỏ câu khoá trước → C forced fail.

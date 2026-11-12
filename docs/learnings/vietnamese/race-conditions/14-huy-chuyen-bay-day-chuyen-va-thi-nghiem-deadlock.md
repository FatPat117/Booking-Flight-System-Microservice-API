# 14 — Huỷ chuyến bay dây chuyền và thí nghiệm deadlock

Day 52. Code: `api/src/flights/cancel-flight.ts`, `api/src/bookings/cascade-flight-cancellations.ts`,
`api/src/bookings/cancel-booking.ts` (lõi huỷ dùng chung), `confirmHold` trong
`api/src/bookings/postgres/postgres-booking-repository.ts`. Test:
`api/tests/integration/postgres-flight-cancellation-race.integration.test.ts`,
`postgres-flight-cancellation-measure.integration.test.ts`. Note tiếng Anh:
`docs/learnings/flight-cancellation-cascade.md`. Quyết định: domain-model Decision 18, ADR-011.

## Vấn đề

Huỷ một chuyến bay đầy là hàng trăm lần ghi: mỗi booking có ghế, có thể có thanh toán, audit, event.
Câu hỏi là làm trong **bao nhiêu transaction**, và điều đó ảnh hưởng gì tới người khác đang giữ ghế,
đang thanh toán trên chính chuyến đó.

| | A — một transaction | B — đổi trạng thái chuyến, rồi job dây chuyền |
|---|---|---|
| Nguyên tử | Có | Không: chuyến `CANCELLED` mà còn booking sống, tối đa một chu kỳ job |
| Khoá giữ | Dòng chuyến bay + mọi ghế, mọi booking, suốt cả lần huỷ | Dòng chuyến bay vài ms; sau đó mỗi transaction một booking |
| Thứ tự khoá | Chuyến bay **rồi** ghế — ngược với câu giữ ghế | Lệnh huỷ không chờ ghế nào |
| Crash giữa chừng | Rollback hết, admin bấm lại | Lần chạy sau làm tiếp |

Chọn **B**.

## Cách làm

1. `POST /api/flights/:id/cancel`: compare-and-set trạng thái chuyến sang `CANCELLED` + một dòng audit.
   **Không** chạm ghế, booking, thanh toán. Từ lúc commit, `onSaleSql` từ chối mọi câu giữ ghế mới.
2. Job `flight-cancellation-cascade-job` (30 s): mỗi transaction **claim một booking** sống của một
   chuyến `CANCELLED` bằng `FOR UPDATE SKIP LOCKED`, gọi lõi huỷ với lý do `AIRLINE`, commit. Hết
   booking thì dừng.
3. Lý do huỷ là **dữ liệu** (`cancellation_reason`), không phải cờ `force`: `CUSTOMER` giữ mốc 24 h,
   `AIRLINE` bỏ mốc nhưng **bắt buộc** chuyến đã `CANCELLED`.
4. `confirmHold` (pha 3 thanh toán) khoá chia sẻ dòng chuyến bay và đòi `status <> 'CANCELLED'`.

## Vì sao không có vòng khoá

Deadlock cần A giữ X chờ Y, B giữ Y chờ X. Lệnh huỷ chuyến **chỉ khoá dòng chuyến bay, rồi không chờ
gì nữa**. Ai chờ nó cũng chỉ chờ một chiều. Hai khoá `FOR SHARE` không chờ nhau, nên confirm (chuyến →
booking) và job (booking → chuyến) dù ngược thứ tự cũng không khép vòng.

## Thí nghiệm (cửa chặn = transaction mở, phát hiện chờ bằng `pg_locks`)

| Kịch bản | Kết quả |
|---|---|
| **A' đối chứng**: phương án A (chỉ trong test) — `UPDATE flights`, câu giữ ghế 12A khoá ghế rồi chờ chuyến, phương án A khoá toàn bộ ghế | **`40P01` 3/3 vòng** — giả thuyết Day 47 đúng |
| A (ép thứ tự) với lệnh huỷ thật, cùng xen kẽ đó | 0 deadlock, câu giữ ghế xếp hàng rồi `SALES_CLOSED` |
| A không ép: 20 câu giữ ghế + 1 lệnh huỷ, 5 vòng × 10 lần chạy | 0 deadlock — nhưng **không câu nào bị `SALES_CLOSED`** |
| A (queue): câu giữ ghế 1 giữ khoá chia sẻ, lệnh huỷ chờ, câu giữ ghế 2 tới sau | câu 2 **được khoá chia sẻ ngay, chen trước** lệnh huỷ đang chờ |
| B1–B3: thanh toán ở pha 2 khi huỷ chuyến (đã / chưa chạy job / pha 3 chờ sau `UPDATE` chưa commit) | không booking nào `CONFIRMED`, tiền ròng 0 |
| B4: pha 3 tới trước, lệnh huỷ chờ | booking được xác nhận **trước** khi huỷ, job huỷ + hoàn tiền |
| B' đối chứng: câu confirm cũ không kiểm tra chuyến | **xác nhận được trên chuyến đã huỷ** |
| C1/C2/C3: khách huỷ và job cùng booking | một lần huỷ, một lần hoàn tiền, lý do của bên thắng |
| D1/D2: đổi ghế và job cùng booking | job nhả **ghế mới**; đổi ghế chờ sau job thì `not-changeable` |
| E: hai job song song, 100 booking (20 đã trả) | mỗi booking huỷ một lần, 100 audit, 100 event, 20 lần hoàn |
| F: job chết sau 4/10 booking | lần sau huỷ nốt 6, không trùng |
| G: hai admin huỷ cùng lúc | một `cancelled`, một `already-cancelled`, một audit |

Cả file chạy 10 lần liên tiếp đều xanh. Mutation: bỏ `status <> 'CANCELLED'` khỏi `confirmHold` → B2,
B3 fail.

### Điều học được từ "A không ép"

Khi một câu giữ ghế đang giữ `FOR SHARE` trên dòng chuyến bay và `UPDATE` của lệnh huỷ đang chờ, một
câu giữ ghế mới tới **vẫn được** `FOR SHARE` ngay vì nó tương thích với khoá đang có — nó không xếp
sau `UPDATE`. Nên lệnh huỷ chỉ chạy khi **không còn ai** giữ khoá chia sẻ. Ở đây vô hại vì mỗi câu
giữ ghế vài ms, nhưng là lý do thí nghiệm "không ép" không bao giờ thấy câu giữ ghế bị từ chối. Phải
ép thứ tự mới kiểm chứng được vế đó.

### Vì sao confirm phải `FOR SHARE`, không chỉ JOIN

READ COMMITTED: confirm bắt đầu khi `UPDATE` của lệnh huỷ chưa commit → snapshot thấy `OPEN`. Nếu chỉ
JOIN đọc, nó **không chờ**, xác nhận rồi commit. Có `FOR SHARE` (xung đột với `FOR NO KEY UPDATE` mà
`UPDATE` cột thường lấy; `FOR KEY SHARE` thì **không** xung đột) → nó chờ; sau khi lệnh huỷ commit,
Postgres đọc lại **phiên bản mới nhất** của dòng đó và chấm lại `WHERE` → không khớp → hoàn tiền.

## Số đo (`booking_test`, 100 booking đã trả, chuyến 120 ghế)

| | B | A (chỉ trong test) |
|---|---|---|
| Transaction giữ dòng chuyến bay | 3–8 ms | 536–601 ms |
| Mỗi transaction của job | median 5–9 ms | — |
| Câu giữ ghế trên cùng chuyến trong lúc huỷ | bị từ chối sau 19–55 ms | bị từ chối sau 535–600 ms |

B **không** xong sớm hơn (tổng tương đương). B làm cho **không ai phải chờ cả lần huỷ**. Đo thời gian
giữ khoá **từng transaction**, đừng chỉ đo tổng.

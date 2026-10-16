# 04 — `SKIP LOCKED` hay chờ khoá?

## Bối cảnh

Từ Day 47 mỗi chuyến có bảng `flight_seats` (mỗi ghế một dòng). Đặt chỗ = chọn ghế `AVAILABLE`
và đổi sang `HELD`. Có hai kiểu chọn, và chúng cần **hai chiến lược khoá ngược nhau**.

## Kiểu 1 — Hệ thống tự chọn: `SKIP LOCKED`

Ghế nào cũng như nhau → bỏ qua ghế người khác đang khoá, lấy ghế kế tiếp.

```sql
SELECT seat.* FROM flight_seats seat JOIN flights flight …
WHERE seat.flight_id = $1 AND seat.status = 'AVAILABLE'
  AND flight.status = 'OPEN' AND flight.departure_at - interval '1 hour' > $now
ORDER BY seat.row, seat.letter
LIMIT $n
FOR UPDATE OF seat SKIP LOCKED      -- khoá ghế, bỏ qua ghế đang bị khoá
FOR SHARE OF flight                 -- giữ nguyên trạng thái chuyến tới hết transaction
```

**Đo được (Day 47):**
- Có `SKIP LOCKED`: 20 request / 50 ghế → 20 ghế khác nhau, không chờ.
- Bỏ `SKIP LOCKED` (C1): **vẫn đúng** (20 ghế khác nhau, không báo hết sai) — vì plan là
  `Limit → LockRows → Sort`, dòng fail re-check sau khi chờ bị bỏ và thử dòng tiếp. Nhưng mọi
  request **xếp hàng** sau ghế 1A (C2: dính `lock_timeout` 55P03). Chậm ~1,5×, càng tệ khi
  transaction dài.
- Bỏ luôn khoá (C3, OCC thuần): **15–16/20 báo hết ghế sai**.

→ `SKIP LOCKED` mua được **thông lượng**, không phải tính đúng.

**Đánh đổi chấp nhận:** "hết ghế" nghĩa là "không còn ghế trống mà không ai đang giữ". Nếu người
đang giữ mấy ghế cuối rollback, người hỏi đúng lúc đó nghe "hết" dù ghế quay lại ngay sau.
Thử lại là được.

**`FOR SHARE OF flight`:** cửa sổ bán vé đọc từ dòng flight mà không ai đổi được trạng thái tới
hết transaction. Share lock không chặn nhau → các booking vẫn chạy song song; chỉ lệnh đổi
trạng thái chuyến phải chờ.

## Kiểu 2 — Khách chọn ghế: chờ khoá, **không** `SKIP LOCKED`

Khách nói "12A và 12B". Nếu `SKIP LOCKED` bỏ qua 12B đang bị khoá thì câu lệnh âm thầm làm mất
đúng ghế khách chọn. Phải **chờ**, rồi đọc trạng thái mới của ghế đó (READ COMMITTED đi theo
chuỗi update tới phiên bản mới nhất) → biết nó đã `HELD` → `409 SEATS_UNAVAILABLE` nêu đúng 12B.

Chờ khoá mở ra rủi ro **deadlock** → giải bằng **thứ tự khoá toàn cục**:

```sql
… WHERE (seat.row, seat.letter) IN (<ghế yêu cầu>)
ORDER BY seat.row, seat.letter     -- LockRows nằm trên Sort → khoá theo thứ tự này
FOR UPDATE OF seat
```

`[12A,12B]` và `[12B,12A]` đều xếp hàng ở 12A trước → không có vòng chờ.
Chi tiết, số đo và mutation: [05-giu-nhieu-ghe-tat-ca-hoac-khong.md](./05-giu-nhieu-ghe-tat-ca-hoac-khong.md).

## Bảng nhớ nhanh

| | Tự chọn | Khách chọn |
|---|---|---|
| Tài nguyên | thay thế được | đích danh |
| Gặp ghế đang khoá | bỏ qua (`SKIP LOCKED`) | chờ |
| Rủi ro | báo hết ghế khi người khác sắp rollback | deadlock |
| Chống rủi ro | chấp nhận, client thử lại | khoá theo (row, letter) |
| Có thể deadlock? | Không — không bao giờ chờ ghế | Có, nếu sai thứ tự |

## Câu trả lời phỏng vấn 30 giây

> "Nếu tài nguyên thay thế được, tôi dùng `FOR UPDATE SKIP LOCKED` để các request lấy ghế khác
> nhau thay vì xếp hàng — tôi đã đo, bỏ nó vẫn đúng nhưng chậm vì queue. Nếu khách chọn đích
> danh thì không được skip, phải chờ, và để không deadlock tôi khoá theo một thứ tự toàn cục."

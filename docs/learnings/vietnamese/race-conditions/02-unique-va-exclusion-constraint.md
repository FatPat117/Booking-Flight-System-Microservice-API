# 02 — UNIQUE và exclusion constraint: luật giữa nhiều dòng

## Vấn đề

Có những luật không nằm trên **một dòng** mà nằm giữa **dòng mới và các dòng khác**:

- Hai người đăng ký cùng email cùng lúc (Day 31).
- Hai booking sinh trùng mã đặt chỗ (Day 48A).
- Hai admin xếp cùng một máy bay vào hai chuyến chồng giờ (Day 46).

"SELECT xem có trùng không → INSERT" đều hỏng: cả hai cùng thấy "chưa có" rồi cùng insert.
Conditional UPDATE cũng không giúp được vì chưa có dòng nào để UPDATE.

## Cách 1 — `UNIQUE` (so sánh bằng nhau)

- `UQ_users_email`, `UQ_airports_code`, `UQ_bookings_reference`, `UQ (flight_number, departure_at)`.
- DB tự khoá index entry, người insert sau **chờ** người trước commit rồi mới biết trùng hay không.
- Map lỗi `23505` theo **tên constraint** → `duplicate` (`isUniqueViolation(error, constraint)`
  trong `api/src/postgres/postgres-errors.ts`). Lấy theo tên vì trùng primary key là bug, phải throw.

### Biến thể quan trọng: `ON CONFLICT DO NOTHING`

Bắt `23505` **bên trong transaction** làm transaction bị abort — mọi câu sau lỗi, COMMIT thành
ROLLBACK. Với mã đặt chỗ, các ghế đã giữ trong cùng transaction sẽ mất theo. Nên dùng:

```sql
INSERT INTO bookings (…) VALUES (…)
ON CONFLICT ON CONSTRAINT "UQ_bookings_reference" DO NOTHING
RETURNING id
```

Rỗng → `reference-taken` → use case sinh mã khác (tối đa 5 lần). Transaction vẫn dùng tiếp được.
Chỉ ghi tên constraint mã đặt chỗ, để xung đột khác (trùng id, sai FK) vẫn ném lỗi.

Race test D (Day 48A): 10 request đồng thời đều sinh trùng mã `K7Q4PZ` ở lần đầu → cả 10 được
tạo, 10 mã khác nhau, đúng 1 cái giữ `K7Q4PZ`.

## Cách 2 — Exclusion constraint (so sánh chồng lấn)

`UNIQUE` chỉ so "bằng nhau". Lịch máy bay cần "**cùng máy bay VÀ khoảng thời gian chồng nhau**":

```sql
EXCLUDE USING gist (
  aircraft_id WITH =,
  flight_aircraft_occupancy(departure_at, arrival_at) WITH &&
) WHERE (status <> 'CANCELLED')
```

- Cần `btree_gist` để dùng `=` trên uuid trong GiST.
- Khoảng `[departure, arrival + 45 phút)` half-open → chuyến sau được bay đúng phút thứ 45.
- Hàm trong index phải `IMMUTABLE`: chỉ đúng khi interval tính bằng **phút**, không có phần ngày.
- Vi phạm → `23P01` → `409 AIRCRAFT_UNAVAILABLE`.

### Bẫy: insert đồng thời ra `40P01`, không phải `23P01`

Mỗi transaction ghi index entry của mình rồi chờ dòng chưa commit của bên kia → vòng chờ →
Postgres huỷ một bên với **deadlock**. Exclusion constraint không có đường xử lý đặc biệt như
unique btree. Xử lý: map `40P01` → `aircraft-unavailable`, **chỉ an toàn vì** insert flight là
câu ghi đầu tiên của transaction (giả định được ghi thành comment trong
`postgres-flight-repository.ts`).

## Câu trả lời phỏng vấn 30 giây

> "Luật giữa nhiều dòng thì app không tự đảm bảo được — tôi giao cho constraint của DB.
> Bằng nhau thì `UNIQUE`, chồng lấn thì exclusion constraint với GiST. Tôi map lỗi theo tên
> constraint. Nếu cần tiếp tục transaction sau khi trùng thì dùng `ON CONFLICT DO NOTHING`
> thay vì bắt lỗi, vì lỗi làm transaction bị abort."

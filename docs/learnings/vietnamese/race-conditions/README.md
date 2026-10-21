# Race condition trong project — bảng tổng

Race condition = kết quả phụ thuộc vào thứ tự xen kẽ của các request đồng thời. Trong project
này, mọi chỗ ghi dữ liệu bị tranh chấp đều có **một kỹ thuật cụ thể** và **một race test trên
Postgres thật** chứng minh nó.

## Nguyên tắc gốc

1. **Không read-then-write ở tầng ứng dụng.** "SELECT kiểm tra → if → UPDATE" luôn có khe hở
   giữa hai câu. Đưa điều kiện vào **chính câu ghi** hoặc vào **constraint của DB**.
2. **Để database quyết định.** App chỉ dịch kết quả (số dòng bị ảnh hưởng, mã lỗi SQL) thành
   `outcome`.
3. **Chứng minh bằng đo, không bằng suy luận.** Mỗi kỹ thuật có test đối chứng (control) cho
   thấy bỏ nó đi thì hỏng thế nào.

## Chọn kỹ thuật theo tình huống

| Tình huống | Kỹ thuật | Ví dụ trong project | File |
|---|---|---|---|
| Đổi trạng thái **một dòng** | OCC: `UPDATE … WHERE <điều kiện>` | Huỷ booking | [01](./01-occ-conditional-update.md) |
| Luật giữa **nhiều dòng**: không trùng | `UNIQUE` + bắt `23505` / `ON CONFLICT` | Email, mã đặt chỗ, airport code | [02](./02-unique-va-exclusion-constraint.md) |
| Luật giữa nhiều dòng: không **chồng lấn** | Exclusion constraint (GiST) | Lịch máy bay | [02](./02-unique-va-exclusion-constraint.md) |
| Chuyển trạng thái theo lifecycle | Compare-and-set `AND status = :expected` | Mở bán chuyến bay | [03](./03-compare-and-set-trang-thai.md) |
| Chọn 1 trong nhiều tài nguyên **giống nhau** | `FOR UPDATE SKIP LOCKED` | Hệ thống tự chọn ghế | [04](./04-skip-locked-va-cho-khoa.md) |
| Tài nguyên **được chỉ đích danh** | Chờ khoá + **thứ tự khoá toàn cục** | Khách chọn ghế 12A, 12B | [04](./04-skip-locked-va-cho-khoa.md), [05](./05-giu-nhieu-ghe-tat-ca-hoac-khong.md) |
| Ghi **nhiều dòng** tất cả hoặc không | Phán quyết nằm trong `WHERE` của câu UPDATE | Giữ 3 ghế cho 3 khách | [05](./05-giu-nhieu-ghe-tat-ca-hoac-khong.md) |
| Đọc điều kiện ở dòng khác lúc ghi | `FOR SHARE OF <bảng đó>` | Cửa sổ bán vé lúc giữ ghế | [04](./04-skip-locked-va-cho-khoa.md) |

| Huỷ đua với đặt lại ghế vừa nhả; nhiều lần huỷ cùng lúc | Huỷ + nhả ghế trong một câu (CTE) + `SKIP LOCKED` | Race test D, E Day 47 | [07](./07-huy-va-dat-lai-dong-thoi.md) |
| Job quét chạy trên nhiều instance | Lô `FOR UPDATE SKIP LOCKED`, một transaction mỗi lô | Hết hạn giữ ghế | [08](./08-het-han-giu-ghe-va-bien-thoi-gian.md) |
| Hai chuyển trạng thái theo thời gian đua nhau | Điều kiện bổ sung `<= now` / `> now` + row lock | Huỷ vs hết hạn (sau này: thanh toán vs hết hạn) | [08](./08-het-han-giu-ghe-va-bien-thoi-gian.md) |
| Nhả nhiều ghế trong khi người khác giữ ghế đó | Khoá trước theo cùng thứ tự toàn cục, rồi mới update | Huỷ / hết hạn vs giữ ghế chỉ định | [08](./08-het-han-giu-ghe-va-bien-thoi-gian.md) |
| Chụp giá trị ở bảng khác đúng lúc quyết định | Đọc trong **cùng câu ghi**, `FOR SHARE`, và CTE phải được JOIN | Giá vé lúc giữ ghế vs đổi giá | [09](./09-chup-gia-va-khoa-dong-gia.md) |

Cách test tất cả những thứ trên: [06-cach-test-race-condition.md](./06-cach-test-race-condition.md).

Năm file race test trong `api/tests/integration/`: `postgres-booking-race` (một ghế mỗi booking, Day 47),
`postgres-booking-hold-race` (nhiều ghế, Day 48A), `postgres-booking-expiry-race` (hết hạn giữ ghế, Day 48B),
`postgres-fare-snapshot` (chụp giá, Day 49A), `flight-schedule-race.postgres` (lịch máy bay, Day 46).

## Các con số đã đo (thuộc lòng để kể khi phỏng vấn)

| Thí nghiệm | Kết quả |
|---|---|
| Day 39: read → check → sleep 30ms → update, 20 request / 5 ghế | 20/20 báo "đặt được", cuối còn 4 ghế (lost update) |
| Day 46: bỏ compare-and-set khi mở chuyến, 10 admin đồng thời | 10 lần "mở" thay vì 1 |
| Day 47 C1: bỏ `SKIP LOCKED` | 0 báo hết ghế sai, nhưng phải xếp hàng (C2 dính `lock_timeout`) |
| Day 48A C3: không khoá dòng (OCC thuần) khi chọn ghế, 20 request / 50 ghế | 15–16/20 báo **hết ghế sai** |
| Day 48A C: khoá theo thứ tự request, không barrier | 98/100 vòng **deadlock** |
| Day 48A B: khoá theo (row, letter) | 0 deadlock, 200/200 vòng |
| Day 48B A/B: 4 sweeper, 50 hold; có / không `SKIP LOCKED` | đều đúng 50 lần hết hạn; ~250 ms có batch chồng nhau / ~910 ms xếp hàng |
| Day 48B C: huỷ và job đúng lúc hạn, 20 vòng | job thắng 20/20, mỗi booking một kết thúc |
| Day 48B E: nhả ghế ngược thứ tự, có cổng khoá 12A | deadlock 5/5; code thật 0 |
| Day 49A B1: hold gặp lần đổi giá chưa commit; có / không `FOR SHARE` | chờ rồi lấy giá mới / không chờ, lấy giá cũ |
| Day 49A B2: đổi giá giữa lúc transaction hold còn mở; có / không `FOR SHARE` | đổi giá chờ, booking commit trước / booking commit **sau** đổi giá mà vẫn giá cũ |

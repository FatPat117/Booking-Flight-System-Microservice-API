# 06 — Cách test race condition (để test có ý nghĩa)

## 1. Chỉ test race trên Postgres thật

Fake in-memory chạy đơn luồng, không có khoá, không có isolation → **không thể fail**. Một race
test xanh trên fake không chứng minh gì (ADR-005). Race test nằm trong `api/tests/integration/`.

## 2. Đi qua use case thật, connection thật

- Gọi `createCreateBooking(...)` với mọi adapter Postgres, `Promise.all` N request.
- Pool mặc định 10 connection → tối đa 10 transaction mở cùng lúc, phần còn lại xếp hàng chờ
  connection. Vẫn là tranh chấp thật trên cùng các dòng ghế.

## 3. Kết thúc bằng kiểm bất biến trên bảng, không chỉ kiểm outcome

Outcome có thể đúng mà dữ liệu sai (ví dụ ghế mồ côi). Mỗi test đọc thẳng bảng:
"ghế HELD = hành khách của booking HELD, không ghế mồ côi, bản sao khớp".

## 4. Ép thứ tự xen kẽ bằng barrier, không bằng `sleep`

```ts
function createBarrier(parties: number): () => Promise<void> { … }  // nhả khi đủ `parties` người tới
```

Đặt barrier **giữa** hai bước (ví dụ sau khi khoá ghế đầu tiên) → hai transaction chắc chắn cùng
giữ ghế đầu trước khi xin ghế thứ hai → deadlock **10/10**, không phụ thuộc may rủi. `sleep 50ms`
từng để một request chậm đọc sau khi request nhanh đã ghi (Day 46).

## 5. Stagger khi cần phủ **cả hai** thứ tự

Day 47 test D (huỷ vs đặt lại): không stagger → 20/20 vòng cùng một thứ tự (người đặt luôn chạy
khi người huỷ còn giữ khoá). Thêm độ trễ 0/1/2/4/8 ms xoay vòng → phủ cả hai thứ tự.

## 6. Control test: dựng bản **sai** để đo cái mình được bảo vệ khỏi

| Control | Bỏ gì | Cho thấy |
|---|---|---|
| C1 | `SKIP LOCKED` | vẫn đúng nhưng xếp hàng |
| C2 | `SKIP LOCKED`, có `lock_timeout` | deterministic: thiếu nó thì chờ, có nó lấy ghế khác ngay |
| C3 | mọi khoá dòng | báo hết ghế sai 15–16/20 |
| C (48A) | thứ tự khoá | deadlock 10/10 với barrier, 98/100 không barrier |

Control chỉ tồn tại trong file test (repository giả dựng bằng spread `...repository` rồi ghi đè
một method), **không bao giờ trong `src/`**. Assert control ở mức "có hiệu ứng" (`soldOut > 0`),
để nếu Postgres thôi tạo ra hiệu ứng đó thì test báo.

## 7. Mutation testing bằng tay

Sửa hỏng đúng chỗ bảo vệ (bỏ `enough.ok`, bỏ `ORDER BY`, bỏ scope) → chạy → **đúng** test tương
ứng phải fail → hoàn tác → `grep -r MUTATION api/src` = 0. Mutation sống sót = phát hiện cần giải
thích (Day 48A: plan tình cờ sort).

## 8. Chạy lặp nhiều lần

File race chạy **10 lần liên tiếp** đều xanh mới tính là xong. Integration chạy
`--test-concurrency=1` vì các file `TRUNCATE` chéo nhau.

## 9. Ghi số đo vào test và vào docs

`t.diagnostic(...)` in con số (bao nhiêu deadlock, bao nhiêu thành công) — có cái assert, có cái
chỉ ghi lại để biết hệ thống thật cư xử ra sao.

## Câu trả lời phỏng vấn 30 giây

> "Race test của tôi chạy trên Postgres thật qua use case thật, kết thúc bằng kiểm bất biến trên
> bảng. Tôi dùng barrier để ép thứ tự xen kẽ thay vì sleep, có control test bỏ từng cơ chế bảo
> vệ để đo nó bảo vệ cái gì, và làm mutation để chắc test bắt được. Chạy 10 lần liên tiếp mới
> tính là ổn định."

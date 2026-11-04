# 13 — Rà soát snapshot: câu lệnh nào chờ khoá rồi đọc theo khoá ngoại?

Day 51 (Bước 0). Code: `api/src/bookings/postgres/postgres-booking-repository.ts` (`confirmHold`,
`expireDueHolds`, comment trỏ về test). Test: `api/tests/integration/postgres-snapshot-audit.integration.test.ts`.
Note tiếng Anh: `docs/learnings/all-or-nothing-holds-and-lock-ordering.md`, mục "Day 51".

## Vấn đề

Day 50 tìm ra: trong READ COMMITTED, **một câu lệnh** đọc snapshot chụp lúc nó **bắt đầu**. Câu huỷ
cũ chờ khoá booking (đang bị đổi ghế giữ), chờ xong vẫn tìm ghế `WHERE booking_id = …` theo snapshot
cũ → nhả ghế cũ, bỏ sót ghế mới. Câu hỏi Day 51: **còn câu nào khác cùng dạng không?**

## Cách rà

Hỏi hai câu cho mỗi câu SQL nhiều nhánh:

1. Nó **có thể phải chờ khoá** không?
2. Sau đó nó có tìm dòng **theo một khoá mà tập dòng khớp có thể đổi** trong lúc chờ không?

| Câu lệnh | (1) | (2) | Vì sao an toàn |
|---|---|---|---|
| `holdAutoSeats` | chỉ khoá share flight/giá; ghế `SKIP LOCKED` | không — `status = 'AVAILABLE'` được kiểm lại trên dòng đã khoá | ghế bị lấy mất thì bị bỏ qua |
| `holdChosenSeats` | có (ghế) | không — ghế theo khoá chính | trạng thái đọc lại trên dòng đã khoá |
| `expireDueHolds` | có (ghế; booking thì `SKIP LOCKED`) | **có**: ghế theo `booking_id` | **bất biến**: ghế của booking `HELD` không đổi |
| `confirmHold` (SettlePayment) | **có** (booking) | **có**: ghế theo `booking_id` | **bất biến**, cùng cái đó |
| `cancel` | có | có | khoá trước bằng câu riêng (Day 50) |
| `changeSeat` | có | không — các câu riêng, ghế theo khoá chính | mỗi câu bắt đầu **sau** khi có khoá |

## Lời giải

Không thêm khoá trước cho `confirmHold`: nó đúng vì **chỉ có 3 người** có thể giữ khoá booking `HELD`
lúc nó chờ — huỷ / hết hạn (đưa booking ra khỏi `HELD` → `confirm` kiểm lại `status = 'HELD'` và
không làm gì) và đổi ghế (từ chối `HELD` → ghế không đổi → snapshot cũ vẫn đúng). Nhưng luật "ghế của
`HELD` không đổi" trước đây **không có gì canh**. Giờ có:

- comment trên `confirmHold` và `expireDueHolds` nêu bất biến và tên file test;
- quy tắc ghi vào learnings: *chờ khoá + tìm theo khoá ngoại ⇒ khoá trước bằng câu riêng, **hoặc**
  một bất biến giữ tập dòng không đổi — và bất biến đó phải có test.*

## Test (dùng "cửa chặn" là transaction mở, phát hiện chờ bằng `pg_locks`, không `sleep`)

| Kịch bản | Kết quả |
|---|---|
| `confirm` chờ sau một lệnh huỷ cùng booking `HELD` | `not-payable`, không ghế nào `BOOKED` |
| `confirm` chờ sau một lệnh đổi ghế (bị từ chối vì `HELD`) | đặt đúng ghế 12A ban đầu |
| **Đối chứng**: một đoạn ghi chỉ có trong test chuyển ghế của booking `HELD` (12A → 14C) | `confirm` dùng snapshot cũ, không đặt ghế nào, `14C` vẫn `HELD` cho booking `CONFIRMED` — hàm bất biến báo lỗi |

Ý nghĩa của đối chứng: ai muốn cho đổi ghế khi `HELD` sẽ thấy ngay vì sao phải thêm khoá trước cho
`confirmHold`. 5 lần chạy liên tiếp đều xanh.

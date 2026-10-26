# Chuẩn bị phỏng vấn từ project này

Mỗi file là một nhóm câu hỏi. Mỗi câu có: **trả lời ngắn** (nói được trong 30–60 giây) và
**bằng chứng trong project** (file, số đo) — phỏng vấn viên tin con số và ví dụ thật hơn lý thuyết.

| File | Chủ đề |
|---|---|
| [kien-truc-va-thiet-ke.md](./kien-truc-va-thiet-ke.md) | Port/adapter, use case, DI, monolith trước microservice, khi nào thêm pattern |
| [database-va-transaction.md](./database-va-transaction.md) | Transaction, isolation, migration, index, bẫy Postgres/TypeORM |
| [concurrency.md](./concurrency.md) | Race condition, OCC, khoá, deadlock |
| [messaging-va-outbox.md](./messaging-va-outbox.md) | RabbitMQ, outbox, DLQ, at-least-once, tiến hoá contract |
| [bao-mat.md](./bao-mat.md) | JWT, 401/403/404, BOLA, least privilege |
| [testing.md](./testing.md) | Chiến lược test, fake vs DB thật, contract test, mutation |
| [van-hanh-docker-va-observability.md](./van-hanh-docker-va-observability.md) | Config, Docker, compose, shutdown, health check, logging, truy vết, sự cố vận hành |

Migration có thư mục riêng: [../migrations/](../migrations/README.md).

## "Kể về project của bạn" — bản 2 phút

> Đây là backend đặt vé máy bay tôi phát triển từng bước, từ một Express API in-memory lên hướng
> microservices: hiện có `api` (chuyến bay, sân bay, máy bay, booking), service `identity` phát
> JWT, và `flight-notifier` consume event qua RabbitMQ. Dữ liệu ở Postgres, mỗi service một
> database và một role không phải superuser.
>
> Phần tôi tâm đắc nhất là **xử lý tranh chấp ghế**. Mỗi chuyến có tồn kho ghế riêng; một booking
> giữ 1–9 ghế theo kiểu tất cả-hoặc-không, mỗi lần giữ là **một câu SQL** với phán quyết nằm
> trong `WHERE`. Ghế do hệ thống chọn thì dùng `FOR UPDATE SKIP LOCKED`; ghế khách chọn thì chờ
> khoá theo một thứ tự toàn cục để không deadlock. Tôi chứng minh bằng race test trên Postgres
> thật, có control test đo được: không khoá thì 15–16/20 request báo hết ghế sai, khoá sai thứ tự
> thì 98/100 vòng deadlock. Giá vé được **chụp** vào từng hành khách ngay trong câu giữ ghế, với
> dòng giá bị khoá `FOR SHARE`, nên đổi giá giữa chừng không bao giờ cho ra booking lẫn giá.
> Thanh toán gọi gateway **ngoài** transaction (ba pha), có Idempotency-Key để gửi lặp không trừ
> tiền hai lần, và tự hoàn tiền khi booking hết hạn đúng lúc đang trừ tiền.
>
> Event đi qua **transactional outbox** nên không mất khi broker chết; consumer có DLQ, ack tay,
> event có `eventId` và `correlationId` để truy vết. Bảo mật có BOLA: quyền sở hữu nằm ngay trong
> câu query, booking của người khác trả 404 y như không tồn tại.
>
> Về quy trình: tôi migrate SQLite sang Postgres theo strangler fig, schema thay đổi bằng
> expand → backfill → contract có bước đối soát từ chối dữ liệu lệch, mỗi quyết định lớn có ADR,
> và tôi dùng mutation testing để chắc test thực sự bắt lỗi.

## Mẹo trả lời

- Mở bằng **vấn đề**, rồi cách giải, rồi **đánh đổi** — đừng chỉ nói tên pattern.
- Luôn có một con số hoặc một lần "tôi đã sai và phát hiện ra nhờ…" (xem mục bẫy trong
  [on-tap-nhanh-day-01-49b.md](../on-tap-nhanh-day-01-49b.md)).
- Nói rõ cái **chưa làm** và vì sao (chưa đối soát payment lỗi, sơ đồ ghế trễ tới ~60 s sau hạn, chưa dedupe consumer):
  biết giới hạn của mình được đánh giá cao.

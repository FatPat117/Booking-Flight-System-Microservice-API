# Phỏng vấn: messaging và outbox

### 1. Dual-write problem là gì? Bạn giải quyết thế nào?

**Trả lời:** Ghi DB rồi publish lên broker là hai hệ thống, không có transaction chung: DB commit
mà publish lỗi → mất event (Day 20 đã thấy: log `publish_failed` mà vẫn trả 201).
**Transactional outbox** (Day 24): ghi event vào bảng `outbox` **cùng transaction** với dữ liệu và
audit. Job relay mỗi 5 giây đọc dòng chưa publish → publish → `markPublished`.
**Đã thử:** tắt RabbitMQ, POST vẫn 201, `published_at` NULL; bật lại → ~5 giây sau event tới
consumer, đúng `eventId`.
**Code:** `api/src/outbox/`, `outbox-relay-job.ts`.

### 2. Đánh đổi của outbox?

**Trả lời:**
- Giao **trễ** (tới lượt relay).
- **At-least-once**: publish xong mà `markPublished` lỗi → giao lại lần nữa → consumer phải idempotent.
- Relay dừng ở lỗi đầu tiên để giữ thứ tự → một dòng độc ở đầu chặn cả hàng.
- Polling, không phải CDC (Debezium) — đủ cho quy mô này.

### 3. DLQ để làm gì? Có thay được outbox không?

**Trả lời:** Không thay được. DLQ chỉ cứu message **đã tới** queue nhưng xử lý thất bại (consumer
`nack(requeue:false)` → qua DLX → DLQ). Outbox cứu **chặng đầu** — broker chết lúc publish.
Bẫy: không đổi được argument của queue tại chỗ; publisher và consumer phải assert cùng
`x-dead-letter-exchange`, không thì `PRECONDITION_FAILED`.

### 4. Vì sao `requeue: false`?

**Trả lời:** Message độc (sai shape) mà requeue thì lặp vô hạn. Đưa vào DLQ để người xem tay.
Cùng với `prefetch(1)` và ack tay sau khi xử lý xong.

### 5. `eventId` và `correlationId` khác nhau thế nào?

**Trả lời:**
- `eventId` = định danh **một message** (= id dòng outbox) → dùng để dedupe.
- `correlationId` = định danh **một luồng nghiệp vụ** = `requestId ?? eventId` → grep log xuyên
  service. Đo được: cùng `x-request-id` xuất hiện ở api và notifier cách nhau ~2 giây.
- `causationId` chưa thêm vì chưa có event sinh ra event khác (sẽ cần khi có Saga).

### 6. Consumer idempotent chưa?

**Trả lời:** Chưa có dedupe store — thành thật. Handler hiện chỉ ghi log nên trùng thì chỉ thêm
một dòng log. Thiết kế đã nghĩ trước: lưu `eventId` đã xử lý (Redis TTL hoặc DB), TTL 7–30 ngày
theo cửa sổ redelivery; check + side effect + mark gặp lại bài toán dual-write → cần inbox
pattern (phase F).

### 7. Tiến hoá contract event thế nào?

**Trả lời:** Contract nằm trong package dùng chung `packages/contracts` (type + parser validate
lúc nhận). Thêm trường thì **optional** trước (message cũ còn trong queue/DLQ). **Không đổi nghĩa
tên event**: khi booking chuyển sang trạng thái giữ chỗ, tôi tạo `booking-held` mới thay vì để
`booking-created` mang nghĩa khác; consumer cũ giữ lại tới khi queue cạn.

### 8. Publisher mất kết nối thì sao?

**Trả lời:** Day 40 phát hiện: broker restart → publisher kẹt "Channel closed" mãi, app không
crash nên Docker không restart. Sửa (Day 41) bằng **reconnect lười**: lần publish tiếp theo thấy
kết nối hỏng thì nối lại, các publish đồng thời dùng chung một lần reconnect, nhịp thử lại chính
là nhịp relay 5 giây. Notifier thì ngược lại: crash và để Docker restart — vì nó không có HTTP
request đang dở.

### 9. Có PII trong event/log không?

**Trả lời:** Event `booking-held` mang tên hành khách (consumer gửi thông báo sẽ cần), nhưng
consumer **không log tên**, chỉ log reference và số hành khách. Audit log cũng không lưu tên.

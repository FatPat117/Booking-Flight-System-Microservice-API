# Background job, consumer và health check

## Job trong process (`api`)

**Code:** `api/src/jobs/job-scheduler.ts`, `in-memory-job-scheduler.ts`, đăng ký trong
`api/src/bootstrap/application.ts`.

| Job | Làm gì | Ghi chú |
|---|---|---|
| `outbox-relay-job` (mặc định 5 giây) | Đọc dòng outbox chưa publish → publish lên queue cùng tên `event_type` → `markPublished` | Dừng ở lỗi publish đầu tiên để giữ thứ tự; log `outbox_publish_failed` |
| `flights-summary-job` | Log tổng số chuyến bay | Dùng lại `findPage({ limit: 1 }).totalItems` thay vì thêm `count()` cho một caller |
| `booking-hold-expiry-job` (60 giây, Day 48B) | Gọi `ExpireHolds`: lô 50, tối đa 20 lô, `SKIP LOCKED`, mỗi lô một transaction | Im lặng khi không có gì; log `booking_holds_expired`; warn `booking_hold_expiry_backlog` khi chạm 20 lô |
| `payment-reconciliation-job` (30 giây, Day 49C) | Gọi `ReconcilePayments`: claim lô 20 (`SKIP LOCKED` + lease `next_attempt_at`), commit, gọi gateway **song song**, ghi từng kết quả trong transaction ngắn; tối đa 5 lô | Log `payments_reconciled`; warn `payment_reconciliation_backlog`; error `payment_refund_needs_attention` từ use case |
| `idempotency-key-cleanup-job` (1 giờ, Day 49C) | Gọi `CleanupIdempotencyKeys`: xoá key `COMPLETED` > 24 h, lô 500, tối đa 20 lô | Log `idempotency_keys_deleted`; warn `idempotency_key_cleanup_backlog` |

**Vì sao không dùng RabbitMQ để lên lịch:** một process, không có bài toán liên service. Đánh đổi
đã biết: chạy nhiều instance thì job chạy trùng — job hết hạn, đối soát và dọn key an toàn nhờ
`SKIP LOCKED` (đối soát thêm **lease**, vì nó gọi gateway sau khi đã commit), outbox relay thì chưa.

**Thứ tự tắt:** dừng job → đóng publisher → đóng DB. Từ Day 48B `stop()` trả `Promise` và **chờ
lượt đang chạy** xong (một lượt job hết hạn là một transaction) — trước đó nó chỉ xoá timer.

**Publisher:** reconnect lười — lần publish sau thấy kết nối hỏng thì nối lại; nhịp thử lại = nhịp
relay. Message không mất vì dòng outbox vẫn chưa publish.

## Consumer (`services/flight-notifier`)

**Code:** `services/flight-notifier/src/messaging/`

| Queue | Handler | Log |
|---|---|---|
| `flight-created` | `createFlightCreatedConsumer` | `flight_created_consumed` |
| `booking-held` | `createBookingHeldConsumer` | `booking_held_consumed` (reference, số khách, hạn giữ — **không tên**) |
| `booking-expired` (Day 48B) | `createBookingExpiredConsumer` | `booking_expired_consumed` (reference, số ghế, hạn; `correlationId` = `eventId` vì không có request) |
| `booking-confirmed` (Day 49B) | `createBookingConfirmedConsumer` | `booking_confirmed_consumed` (reference, số khách, `paymentId`, số tiền — không tên) |
| `booking-created` | `createBookingCreatedConsumer` | chỉ còn để đọc message cũ trước Day 48A |

- `prefetch(1)`, ack tay; parse bằng `packages/contracts` → sai shape thì `rejected` → `nack(requeue:false)` → `<queue>.dlx` → `<queue>.dlq`.
- Không có HTTP; khởi động `connectConsumerWithRetry` (10 lần × 2 giây), lỗi thì thoát và để
  Docker restart (`restart: unless-stopped`).
- Chưa dedupe theo `eventId` (handler chỉ log).

## Health check (`api`)

| Route | Kiểm | Dùng cho |
|---|---|---|
| `GET /live` (và `/health`) | process còn sống | Docker HEALTHCHECK → restart |
| `GET /ready` | `SELECT 1` vào Postgres → 200 hoặc 503 (không lộ lỗi DB) | quyết định nhận traffic |

DB chập chờn **không** được làm restart process → tách liveness và readiness. `/ready` chưa kiểm
RabbitMQ.

## Observability

- Mỗi request có `x-request-id` (dùng lại của client nếu ≤ 128 ký tự, không thì sinh UUID), log
  JSON `request_finished` với thời gian xử lý.
- `correlationId = requestId ?? eventId` đi theo event qua outbox → broker → consumer → grep một
  lần thấy cả luồng.

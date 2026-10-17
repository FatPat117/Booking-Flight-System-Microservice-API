# Phỏng vấn: vận hành, Docker, config và observability

### 1. Config đọc từ đâu, xử lý sai thế nào?

**Trả lời:** `parseConfig(env)` (`api/src/config.ts`) là **hàm thuần nhận env làm tham số** — test
truyền object, không đụng `process.env`. `process.env` chỉ đọc một lần lúc khởi động.
- Biến **không đặt** → default an toàn (`PORT` 3000, `RABBITMQ_URL` localhost).
- Biến **đặt nhưng rỗng/sai** → throw ngay: phân biệt "chưa cấu hình" với "cấu hình sai".
- Bí mật **không có default**: `JWT_SECRET` (≥ 32 ký tự), `BOOKING_POSTGRES_USER/PASSWORD`
  thiếu là app không khởi động (fail fast, trước khi mở DB).
- Không dùng thư viện dotenv: `node --env-file-if-exists=.env`.

### 2. Dockerfile của bạn có gì đáng nói?

**Trả lời:** (`api/Dockerfile`)
- **Multi-stage**: stage build có devDependencies, stage runtime chỉ `npm ci --omit=dev` và copy `dist`.
- **Non-root**: user `appuser` uid 1001.
- **Monorepo**: build context là gốc repo; copy `package.json` của workspace trước để cache
  `npm ci`; build `packages/contracts` **trước** `api`; `--ignore-scripts` để không chạy
  `postinstall` trong image.
- **HEALTHCHECK gọi `/live`**, không gọi `/ready`: DB chập chờn không được làm container bị restart.
- **`CMD ["node", "api/dist/index.js"]`** dạng exec → node là PID 1, nhận SIGTERM để tắt êm
  (không bọc qua `npm start` hay shell).

### 3. Graceful shutdown?

**Trả lời:** SIGTERM/SIGINT → `httpServer.close()` (ngừng nhận request, chờ request đang chạy) →
`runtime.close()`: **dừng job trước**, đóng publisher, rồi mới đóng DB — để tick job đang dở
không đụng DB đã đóng. Đo được ~5 ms ở Day 40. Day 48B: "dừng job" trước đó chỉ xoá timer — một
lượt job hết hạn (là một transaction) có thể đang chạy khi DataSource bị huỷ. Giờ
`JobScheduler.stop()` trả `Promise` và **chờ lượt đang chạy** xong; có unit test và mutation.

### 4. Liveness khác readiness?

**Trả lời:**
- `/live`: process còn sống → dùng để **restart**.
- `/ready`: `SELECT 1` vào Postgres → 200/503, dùng để quyết định **nhận traffic**. Không trả
  nguyên văn lỗi DB ra ngoài.
Gộp làm một thì DB chết vài giây sẽ làm orchestrator restart hàng loạt process khoẻ mạnh.
Giới hạn: `/ready` chưa kiểm RabbitMQ (cố ý: HTTP path không dùng broker, outbox lo phần đó).

### 5. docker-compose tổ chức thế nào?

**Trả lời:** `app`, `flight-notifier`, `rabbitmq` (management UI 15672), `postgres` (một container,
hai database `identity_db` + `booking_db`, mỗi cái một role riêng do script trong
`docker/postgres-init/` tạo). `depends_on: condition: service_healthy`, healthcheck cho từng service,
`restart: unless-stopped`. Trong container, broker là hostname `rabbitmq` (DNS của compose), từ
máy host là `localhost`.
**Bài học:** dựng hạ tầng xong, kiểm `getent hosts rabbitmq` rồi mới viết code amqplib — tránh lẫn
lỗi compose với lỗi client.

### 6. Một sự cố vận hành bạn từng gặp?

**Trả lời:**
- `docker compose down -v` xoá volume Postgres/RabbitMQ **ngay dưới** ba process `npm run dev`
  đang chạy (Day 40) → giờ luôn kiểm `ps aux | grep tsx` trước.
- Publisher RabbitMQ kẹt "Channel closed" sau khi broker restart; app không crash, `/live` vẫn
  khoẻ → Docker không có tín hiệu restart. Sửa bằng reconnect lười trong process (Day 41).
- Queue argument không đổi tại chỗ được → `PRECONDITION_FAILED` khi thêm DLX; phải xoá queue cũ.
- WSL dừng container Postgres (exit 255) → `docker compose start`, không `-v`.

### 7. Logging và truy vết request?

**Trả lời:** Logger JSON một dòng (`api/src/observability/logger.ts`). Middleware observability
chạy **đầu tiên**:
- Lấy `x-request-id` của client nếu hợp lệ (không rỗng, ≤ 128 ký tự — chống log bị bơm), không thì
  sinh UUID; trả lại trong header.
- Lưu vào `AsyncLocalStorage` → mọi chỗ trong request đọc được mà không truyền tham số.
- Log `request_finished` với status và thời gian; **không log body** (có thể có PII).
- Lỗi bất ngờ log đầy đủ `unexpected_error` phía server, client chỉ nhận 500 chung.

### 8. Truy vết xuyên service?

**Trả lời:** `correlationId = requestId ?? eventId` được ghi vào payload outbox → relay → RabbitMQ
→ consumer log lại. Grep một id thấy cả luồng: request ở api lúc 16:24:17, consumer xử lý lúc
16:24:19 (Day 29). Chưa có OpenTelemetry/Jaeger (phase G).

### 9. Migration chạy lúc nào?

**Trả lời:** Trong process lúc khởi động (`dataSource.runMigrations()` trong Composition Root), mỗi
migration một transaction. Đủ an toàn khi chỉ chạy một instance; nhiều instance thì cần chạy
migration như một bước deploy riêng. Có script chạy riêng:
`npm run postgres:migration:run --workspace=@booking-flight-system/api`.

### 10. Giới hạn vận hành hiện tại (nói thật)?

**Trả lời:** Job in-process chạy trùng nếu nhiều instance (job hết hạn giữ ghế thì an toàn nhờ
`SKIP LOCKED`, outbox relay thì chưa); sơ đồ ghế có thể còn `HELD` tới ~60 s sau hạn; chưa có metrics/tracing; DLQ xem tay,
chưa cảnh báo; credentials RabbitMQ `guest` chỉ cho local; chưa có CI (phase H).

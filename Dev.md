**Dev hàng ngày (xem log rõ, hot reload):** RabbitMQ + Postgres trong Docker; `api` / `flight-notifier` / `identity` chạy `npm run dev`.

```bash
# Terminal 1 — broker + identity DB
docker compose up rabbitmq postgres

# Terminal 2 — API (log request_finished + correlationId)
npm run dev --workspace=@booking-flight-system/api

# Terminal 3 — consumer (log flight_created_consumed / booking_created_consumed)
npm run dev --workspace=@booking-flight-system/flight-notifier

# Terminal 4 — Identity (:3001 register + JWT login)
npm run dev --workspace=@booking-flight-system/identity
```

| Thành phần | Chạy ở đâu | Vì sao |
|------------|------------|--------|
| RabbitMQ | Docker | Không cần code, port `5672` / UI `15672` |
| Postgres | Docker | Identity DB (Day 31+) |
| api | `npm run dev` | Log trực tiếp + reload khi sửa |
| flight-notifier | `npm run dev` | Log consume thấy ngay |
| identity | `npm run dev` | Register + login JWT trên `:3001` |

`.env` đã có `RABBITMQ_URL=amqp://guest:guest@localhost:5672` và `JWT_SECRET` (≥32 chars) — đúng cho mode này.

---

**Không làm:** `docker compose up` full stack **và** `npm run dev` cùng lúc → trùng port `3000`, 2 consumer chia message, log rối.

Nếu đang full Docker:

```bash
docker compose stop app flight-notifier
# giữ rabbitmq chạy
```

---

**Khi nào full Docker?**

```bash
docker compose up --build
```

Chỉ khi smoke test image / Dockerfile / monorepo build — **không** hot reload; xem log bằng `docker compose logs -f app flight-notifier`.

---

**Tóm lại:** mỗi ngày code/test log → `rabbitmq` Docker + 2 lệnh `dev`. Full compose chỉ khi kiểm tra build.
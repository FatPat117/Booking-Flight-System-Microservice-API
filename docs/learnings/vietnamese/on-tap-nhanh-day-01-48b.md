# Ôn tập nhanh: Day 1 → Day 48B

> Sổ tay tiếng Việt để đọc lại nhanh. Mỗi mục gồm: **vấn đề → cách xử lý → vì sao**, kèm đường dẫn tới code thật.
> Các note tiếng Anh khác trong `docs/learnings/` đi sâu từng chủ đề; file này là bản đồ tổng.
> Cập nhật đến: **Day 48B** (2026-10-17). Số test hiện tại: api unit 377, integration 140, notifier 10, identity 12.

---

## 0. Hệ thống hiện tại trông như thế nào

```text
npm workspaces
├── packages/contracts      kiểu event dùng chung + parser (flight-created, booking-held, booking-expired, booking-created cũ)
├── api                     Express: flights, airports, aircraft, bookings; outbox relay; job hết hạn giữ ghế; Postgres booking_db
├── services/identity       register/login, phát JWT (Postgres identity_db)
└── services/flight-notifier  consumer RabbitMQ (log event, DLQ)

Request → observability (requestId) → JWT + role → use case → TransactionRunner
        → repository (Postgres) + AuditRecorder + Outbox  ──relay 5s──► RabbitMQ ──► notifier
```

Quy ước code cốt lõi (nhớ để đọc code nhanh):

| Quy ước | Ý nghĩa |
|---|---|
| Factory function `createX(deps)` | Không dùng class, trừ entity/migration TypeORM và `Error` subclass |
| Discriminated union `{ outcome: ... }` | Kết quả mong đợi là **giá trị trả về**, không phải exception. `throw` chỉ cho lỗi lập trình/hạ tầng |
| Port + adapter | `booking-repository.ts` (interface, không biết HTTP/DB) + `postgres/postgres-booking-repository.ts` |
| Composition Root | Chỉ `api/src/bootstrap/application.ts` được `new`/mở hạ tầng |
| Port I/O luôn `Promise` | Bài học đắt nhất nhóm B: đã phải đổi sync → async **4 lần** |

---

## 1. Dòng thời gian — mỗi ngày một câu

### Giai đoạn A: Nền móng → messaging (Day 1–30)

| Day | Xây gì | Bài học đáng nhớ |
|---|---|---|
| 1 | Express + mảng in-memory | List rỗng trả `200 []`, không phải 404. Server tự sinh UUID + `Location` |
| 2 | Validation tay | Body là `unknown`, gom **mọi** lỗi một lần (422), map field tường minh (không `...req.body`) |
| 3 | `createApp()` tách khỏi `listen()` | Tách vì test bị dính port — có đau mới tách |
| 4 | Error envelope + middleware lỗi | Thứ tự `json → routes → notFound → errorHandler`; 500 không lộ stack |
| 5 | SQLite | Luật trùng chuyển xuống `UNIQUE` của DB |
| 6 | Repository pattern | Repo trả `created \| duplicate`, route mới map ra 409 |
| 7 | Use case `CreateFlight` | Test bằng fake, không Express, không DB |
| 8 | `parseConfig(env)` | Hàm thuần nhận env làm tham số; thiếu → default, **rỗng → lỗi**; fail fast trước khi mở DB |
| 9 | Phân trang | `ORDER BY departure_at, id` — `id` làm tie-breaker để trang ổn định; xoá `findAll` |
| 10 | Logging + requestId | `AsyncLocalStorage`; chỉ tin `x-request-id` của client nếu ≤ 128 ký tự |
| 11 | `/live` vs `/ready` | DB chết không được làm restart process → tách liveness/readiness |
| 12 | API key (sau bị thay bằng JWT) | Chỉ bảo vệ route ghi; key quá ngắn fail lúc khởi động |
| 13 | Audit log | Chỉ audit thành công; inject `generateId/getCurrentTime/getRequestId` để test xác định |
| 14 | `TransactionRunner` | Validate **ngoài** transaction cho transaction ngắn; test rollback khi audit lỗi |
| 15 | Migration có tracking | `CREATE TABLE IF NOT EXISTS` không sửa được schema cũ |
| 16 | Composition Root (DI tay) | Sửa đau wiring **trước khi** thêm job/broker |
| 17 | Job in-process | Không cần RabbitMQ để "chạy mỗi N ms"; close: dừng job **rồi** đóng DB |
| 18 | Docker multi-stage, non-root | HEALTHCHECK dùng `/live`; `node` là PID 1 để nhận SIGTERM |
| 19 | docker-compose | Dựng hạ tầng trước, code client sau — tránh lỗi mơ hồ |
| 20 | Producer RabbitMQ | Chấp nhận có ý thức lỗ hổng dual-write (sửa Day 24) |
| 21 | Consumer ack/nack tay | `requeue:false` chống poison message lặp vô hạn |
| 22 | Tách `flight-notifier` | Liệt kê rõ service **cần** gì và **không cần** gì |
| 23 | Dead Letter Queue | Không đổi được argument của queue tại chỗ → `PRECONDITION_FAILED` |
| 24 | **Outbox** | DLQ chỉ cứu message đã tới queue; outbox cứu chặng đầu (broker chết lúc publish) |
| 25 | `eventId` = id dòng outbox | Thêm vào contract sớm khi còn rẻ; dedupe để sau |
| 26 | Booking + **OCC** | `UPDATE ... WHERE available_seats > 0` — một câu lệnh, không read-then-write |
| 27 | Package contracts dùng chung | Đảo quyết định Day 22 khi bằng chứng thay đổi (ADR-002 → 003) |
| 28 | Cancel booking | OCC ngược: `WHERE status='active'`; huỷ lần 2 → 409 (không phải 204) |
| 29 | `correlationId` | `requestId ?? eventId`; eventId = 1 message, correlationId = 1 luồng nghiệp vụ |
| 30 | ADR 001–004 | Giữ ADR bị thay thế, không viết lại lịch sử |

### Giai đoạn B: Identity + Postgres (Day 31–42B)

| Day | Xây gì | Bài học đáng nhớ |
|---|---|---|
| 31 | Identity service + register | Race đăng ký trùng: app check không đủ → `UNIQUE(email)` + bắt `23505` |
| 32 | JWT login | Sai email và sai password trả **cùng một body 401** (chống dò email). JWT chỉ ký, không mã hoá |
| 33 | `verifyJwt` trên api | Thử cơ chế trên route probe `/api/whoami` trước khi áp vào route thật |
| 34 | Role `admin` | 401 = không biết bạn là ai, 403 = biết nhưng không được phép. Đóng mass-assignment bằng cấu trúc (repo không có tham số role) |
| 35 | Kế hoạch SQLite → Postgres | Phát hiện: 4 bảng chung một ranh giới transaction → không thể cutover từng bảng |
| 36 | Postgres flight repo | **Test biến mất im lặng**: `sh` không có globstar, `tests/**/*.test.ts` bỏ sót 23 file |
| 37 | Transaction context (ALS) | Repo resolve `getRepository()` lúc tạo **không bao giờ tham gia transaction** — chỉ test rollback chéo bắt được |
| 38 | Audit trên Postgres | **COMMIT trên transaction đã lỗi không throw** — Postgres âm thầm ROLLBACK |
| 39 | Booking repo + race test thật | Counter-proof: read-check-sleep-update → 20/20 "thành công" trên 5 ghế (lost update) |
| 40 | Cutover toàn bộ | Test chạy bằng superuser đã che lỗi quyền; `down -v` xoá volume dưới process dev đang chạy |
| 41 | Xoá SQLite, chiến lược test | Fake + contract test; dự đoán số test `186 − 34 + 7 = 159` → chạy ra đúng 159 |
| 42 | Bỏ superuser cho identity | Identity là superuser suốt 9 ngày không ai biết; thêm test "not superuser" |
| 42B | Reset roadmap | Domain trước CQRS (ADR-007): ~5 use case chưa phải bằng chứng cần CQRS |

### Giai đoạn D: Domain đầy đủ trong `api` (Day 43 → nay)

| Day | Xây gì | Bài học đáng nhớ |
|---|---|---|
| 43 | Scope + domain model (chỉ docs) | 30 business rule có mã (BR-*), lifecycle, thứ tự 10 bước của phase D |
| 44 | Chủ sở hữu booking (BOLA) | Scope nằm **trong query**, kể cả query phụ chỉ để chọn lỗi |
| 45 | Airport, aircraft, seat layout | Chặn khuếch đại đầu vào: kiểm giới hạn **trước** khi expand |
| 46 | Flight tham chiếu + lifecycle | Status dẫn xuất từ đồng hồ; exclusion constraint; deadlock `40P01` khi insert đồng thời |
| 47 | Tồn kho ghế mỗi chuyến | `SKIP LOCKED`; đếm ghế lúc đọc; FK deferred |
| 48A | Nhiều hành khách + mã đặt chỗ | Giữ ghế tất cả-hoặc-không trong 1 câu lệnh; thứ tự khoá toàn cục |
| 48B | Job hết hạn giữ ghế | Job trả ghế, đọc thì suy ra `EXPIRED`, quyết định tự kiểm hạn; biên `<=`/`>` bổ sung chính xác; nhả ghế cũng theo thứ tự khoá |

---

## 2. Những phần xử lý hay — theo chủ đề

### 2.1 HTTP & validation

- **Body là `unknown`, validate ra `ValidationResult<T>`**, gom hết lỗi → client sửa một lần. `api/src/validation.ts`, `*-validation.ts`.
- **Kiểm kích thước trước khi xử lý từng phần tử** (Day 45, 48A): mảng 100.000 cabin hay 10.000 hành khách chỉ tốn **một phép so sánh**, trả đúng một lỗi. `aircraft/seat-layout.ts`, `bookings/booking-validation.ts`.
- **Từ chối trường cũ có tên** thay vì lặng lẽ bỏ qua: `availableSeats` (Day 46), `passengerName` (Day 48A) → `422 UNSUPPORTED_FIELD` kèm chỉ dẫn.
- **Luật nghiệp vụ thành kiểu dữ liệu**: `CreateBookingInput = { seatSelection: "auto" } | { seatSelection: "chosen" }` → use case **không thể** nhận request trộn (BR-BOOK-09).
- **ID sai định dạng → 404** qua `isUuid()`, không để Postgres ném `22P02` thành 500.
- **Mã lỗi đúng nghĩa**: 409 = hợp lệ nhưng xung đột trạng thái; 422 = dữ liệu sai; `UNKNOWN_SEAT` (422, ghế không tồn tại) khác `SEATS_UNAVAILABLE` (409, ghế bị giữ).

### 2.2 Kiến trúc code

- **Repository không biết HTTP**: trả `outcome`, route mới dịch ra status (Day 6).
- **Use case nhận dependency qua một object**, kể cả đồng hồ và bộ sinh id → test xác định (Day 13).
- `**AsyncLocalStorage**` dùng 3 lần: requestId (Day 10), user đã xác thực (Day 33), **transaction hiện tại** (Day 37) — để repository tự tham gia transaction mà port không lộ kiểu TypeORM. `api/src/postgres/transaction-context.ts`.
- **Mapping entity ↔ domain** nằm riêng trong adapter (`mapFlight`, `mapBooking`): domain chỉ thấy ISO string, không thấy `Date`/snake_case.

### 2.3 Transaction & bẫy Postgres

- **Lỗi DB bị bắt bên trong transaction phải kết thúc công việc của transaction đó** (ADR-004 phụ lục Day 38): sau một câu lỗi, mọi câu sau báo "transaction is aborted", còn COMMIT thì âm thầm thành ROLLBACK.
- **Dùng `ON CONFLICT DO NOTHING RETURNING id` thay vì bắt `23505`** khi cần tiếp tục transaction (mã đặt chỗ, Day 48A): kết quả rỗng = trùng → sinh lại, ghế đã giữ vẫn còn.
- **TypeORM không chặn transaction lồng nhau** → tự viết `NestedTransactionError` (Day 37).
- `**.returning()` của TypeORM nhận tên property** (`flightId`), truyền tên cột thì nó lặng lẽ bỏ RETURNING (Day 39).
- **FK `DEFERRABLE INITIALLY DEFERRED`** (Day 47): giữ ghế trỏ tới booking id **trước** khi insert booking → giữ ghế thất bại thì không có gì để hoàn tác. Ngoài transaction, FK được kiểm cuối câu lệnh.

### 2.4 Concurrency — phần quan trọng nhất

| Kỹ thuật                                     | Dùng khi                                                        | Ở đâu                                                      |
| -------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| **OCC: `UPDATE ... WHERE <điều kiện>`**      | Chuyển trạng thái **một dòng** (huỷ booking, mở chuyến)         | `cancel`, `changeStatus`                                   |
| **Compare-and-set** `AND status = :expected` | Thay đổi trạng thái có thể bị tranh                             | Day 46 `open-flight` (bỏ đi → 10 chuyến cùng mở thay vì 1) |
| `**UNIQUE` / exclusion constraint**          | Luật giữa **nhiều dòng** (trùng email, lịch máy bay chồng nhau) | `EXCL_flights_aircraft_schedule` (GiST + `btree_gist`)     |
| `**FOR UPDATE SKIP LOCKED**`                 | Chọn 1 trong nhiều tài nguyên **thay thế được**                 | Giữ ghế tự động                                            |
| **Chờ khoá + thứ tự khoá toàn cục**          | Tài nguyên khách **đã chọn đích danh**                          | Giữ ghế chỉ định: `ORDER BY row, letter FOR UPDATE`        |
| `**FOR SHARE OF flight**`                    | Đọc điều kiện ở dòng khác mà không cho nó đổi                   | Cửa sổ bán vé lúc giữ ghế                                  |

Những điều **đo được** (không đoán):

- Day 39: read-then-write ngây thơ → 20/20 "đặt được" trên 5 ghế, cuối cùng còn 4 (lost update).
- Day 47: bỏ `SKIP LOCKED` **không** gây báo hết ghế sai trên Postgres (LockRows nằm dưới Limit, dòng fail re-check bị bỏ và thử dòng kế) — cái giá là **xếp hàng** (C2: `lock_timeout`).
- Day 48A C3: không khoá dòng nào (OCC thuần) → **15–16/20 báo hết ghế sai** dù còn 30 ghế. Từ chối sai là đặc tính của OCC.
- Day 46: insert chồng lấn đồng thời trên exclusion constraint → `40P01` (deadlock), không phải `23P01` → map thành 409, chỉ an toàn vì insert là câu ghi **đầu tiên**.
- Day 48A: khoá theo thứ tự request → deadlock **98/100** vòng không cần barrier. "Race hiếm" là sai.

Hai bẫy khi giữ **nhiều** dòng (Day 48A):

1. **Commit một nửa**: phán quyết (đủ ghế chưa?) phải nằm **trong `WHERE` của chính câu UPDATE** (`WHERE enough.ok`), không phải kiểm sau.
2. **Deadlock**: mọi câu khoá nhiều ghế phải khoá theo **(row, letter)**. Mutation bỏ `ORDER BY` vẫn xanh vì plan *tình cờ* sort — **plan không phải lời hứa, `ORDER BY` mới là**.

Hết hạn giữ ghế (Day 48B) — ba câu hỏi "hold này hết chưa?", ba cách trả lời:

| Ai hỏi | Cách | Vì sao |
|---|---|---|
| Tồn kho ghế | **Job** 60 s, lô 50, tối đa 20 lô, `SKIP LOCKED` | Suy ra khi đọc thì mỗi lần đếm ghế phải join `bookings`, và câu giữ ghế phải "cướp" ghế còn ghi `HELD` |
| Hiển thị | **Suy ra khi đọc** (`withEffectiveStatus`) | Chủ booking không bao giờ thấy hold đã hết, kể cả trước khi job chạy |
| Quyết định (huỷ, thanh toán) | **Kiểm hạn trong chính `WHERE`** (`hold_expires_at > $now`) | Kết quả chỉ phụ thuộc đồng hồ, không phụ thuộc job đã chạy chưa |

- **Biên bổ sung** (BR-BOOK-10): hết hạn `<= now`, còn hiệu lực `> now`. Test **đúng tại thời điểm hạn** và trước 1 ms — test cách xa 1 phút không phân biệt được `<` với `<=`.
- **Huỷ vs hết hạn cùng lúc**: hai điều kiện loại trừ nhau + row lock → mỗi booking đúng **một** kết thúc. Đồng hồ lệch vài ms thì người ghi sau re-check `status = 'HELD'` và không khớp.
- **Nhả ghế cũng phải theo thứ tự khoá**: giữ ghế chỉ định khoá ghế **bất kể trạng thái**; huỷ cũ nhả bằng `UPDATE … WHERE booking_id` (thứ tự quét) → có thể vòng chờ. Giờ khoá trước `ORDER BY flight_id, row, letter FOR UPDATE` rồi mới update (`releaseSeatsOf`, dùng chung).
- Đo: 4 sweeper song song ~250 ms, có batch chạy chồng nhau; bỏ `SKIP LOCKED` vẫn đúng nhưng **xếp hàng** ~910 ms, 0 batch chồng. Nhả ghế ngược thứ tự + cổng khoá 12A → deadlock **5/5**; code thật → 0.

### 2.5 Migration an toàn

- **Expand → backfill → contract** (Day 44, 46, 47, 48A): thêm cột nullable → điền dữ liệu → khối `DO` **đối soát và từ chối kèm danh sách + HINT** thay vì xoá dữ liệu, rồi mới `NOT NULL`/drop.
- `**migrationsTransactionMode: "each"**` (Day 46): contract bị từ chối thì expand + backfill vẫn được giữ, người sửa dữ liệu tay rồi chạy lại.
- Luôn thử trên **dữ liệu dev cố tình làm lệch** (chuyến bán quá số ghế, booking không có ghế…) để chứng minh contract biết từ chối.
- `IMMUTABLE` khai báo cho hàm dùng trong index chỉ đúng khi interval **không có phần ngày/tháng** (`'1440 minutes'`, không `'1 day'`).
- Sinh ngẫu nhiên trong SQL không cần extension: byte của `gen_random_uuid()` `% 32` (backfill mã đặt chỗ).

### 2.6 Messaging

- **Outbox**: ghi event cùng transaction với dữ liệu; relay 5s publish rồi `markPublished`. Đánh đổi: giao trễ, có thể giao **2 lần**, một dòng độc ở đầu chặn cả hàng.
- **DLQ** với fanout DLX; consumer sở hữu topology; publisher phải assert **cùng argument**.
- **Consumer**: `prefetch(1)`, ack tay, `nack(requeue:false)`; validate event trên dây bằng parser trong `packages/contracts`.
- **Tiến hoá contract**: thêm trường optional (expand); **không đổi nghĩa tên event** → tạo `booking-held` mới thay vì để `booking-created` mang nghĩa khác; giữ consumer cũ đọc message còn tồn.
- **Không log PII**: consumer `booking-held` log reference + số hành khách, không log tên; `booking-expired` (Day 48B) log reference + số ghế.
- **Event do job sinh ra** (Day 48B) không có request phía sau → `correlationId` = chính `eventId`. Actor audit là `system/booking-hold-expiry`.
- **Reconnect lười trong process** (Day 41): app không crash nên Docker không có tín hiệu restart → publisher tự nối lại khi publish tiếp theo.

### 2.7 Bảo mật

- **BOLA** (Day 44): `BookingAccessScope = owner | admin` truyền vào **mọi** query, kể cả query phụ chọn lỗi; booking của người khác trả **404 giống hệt** booking không tồn tại. Tra cứu theo mã đặt chỗ dùng cùng luật (mã 6 ký tự dễ đoán hơn UUID).
- **Chống dò tài khoản**: login sai email/sai mật khẩu cùng một body.
- **Mass assignment**: repository không có tham số `role`; promote admin chỉ qua CLI.
- **Least privilege Postgres**: mỗi service một role `NOSUPERUSER`, `REVOKE CONNECT ... FROM PUBLIC`; có test khẳng định "không phải superuser".
- **Token giữ role cũ đến khi hết hạn** — promote xong phải login lại.
- **Response công khai dùng allow-list key**: test duyệt mọi key ở mọi độ sâu của seat map, field mới lỡ thêm (bookingId…) sẽ làm test fail.

### 2.8 Testing

- **Hai tầng (ADR-005)**: unit/HTTP trên fake (logic nghiệp vụ); integration trên Postgres thật (transaction, constraint, race). **Không test race trên fake** — fake đơn luồng không thể fail.
- **Contract test**: cùng một bộ hành vi chạy trên fake **và** Postgres → fake không trôi khỏi thực tế.
- **Race test** qua use case thật, pool 10 connection; **barrier** để ép thứ tự xen kẽ thay vì `sleep`; luôn kết thúc bằng **kiểm bất biến trên bảng**.
- **Control test**: dựng biến thể sai (không `SKIP LOCKED`, không khoá, khoá sai thứ tự) **chỉ trong test** để đo cái mình đang được bảo vệ khỏi.
- **Mutation**: sửa hỏng code có chủ đích → đúng test tương ứng phải fail → hoàn tác, `grep MUTATION` = 0. Mutation sống sót = một phát hiện (Day 48A `ORDER BY`).
- **Mutation phải giữ SQL hợp lệ** (Day 48B): bỏ điều kiện `> $2` làm `$2` không còn được dùng → Postgres không suy được kiểu → 14 test fail vì lỗi cú pháp, **không phải bằng chứng**. Giữ tham số, chỉ đổi hành vi.
- **Race test cần "cổng"** (Day 48B): câu lệnh đơn chạy quá nhanh, race không bao giờ xảy ra; giữ khoá 12A ở một transaction thứ ba để ép hold xếp hàng trước release → thứ tự xen kẽ xác định.
- **Đồng hồ giả nhảy ngay sau khi bị đọc**: bắt được code đọc `now` nhiều lần trong một lần chạy.
- **Đối chiếu số test** sau mỗi thay đổi; đừng tin "xanh" mà không nhìn số (`tests `** bỏ sót 23 file ở Day 36).
- `--test-concurrency=1` cho integration: các file `TRUNCATE` chéo nhau.

### 2.9 Vận hành

- Liveness `/live` cho restart, readiness `/ready` (`SELECT 1`) cho traffic.
- **`JobScheduler.stop()` chờ lượt đang chạy** (Day 48B): trước đó chỉ xoá timer, `close()` có thể huỷ DataSource dưới một transaction đang dở.
- Trước `docker compose down -v`: kiểm `ps aux | grep tsx` — xoá volume dưới process đang chạy.
- WSL đôi khi dừng container Postgres (exit 255) → `docker compose start postgres`, **không** `-v`.
- Image monorepo: build context ở root, build `contracts` trước, `npm ci --ignore-scripts`.

---

## 3. Bẫy đã gặp — đọc lướt trước khi code

1. COMMIT trên transaction lỗi → ROLLBACK im lặng (Day 38).
2. Repository cache `getRepository()` → không tham gia transaction (Day 37).
3. Glob `**` trong npm script chạy bằng `sh` → mất test im lặng (Day 36).
4. Test integration chạy bằng superuser che lỗi quyền (Day 40).
5. `.returning("flight_id")` → RETURNING bị bỏ, không lỗi (Day 39).
6. Exclusion constraint + insert đồng thời → `40P01`, không phải `23P01` (Day 46).
7. `Intl` trên Node 22 đổi `Asia/Ho_Chi_Minh` → `Asia/Saigon` và nhận cả `"+07:00"` (Day 45).
8. Bảng vừa `TRUNCATE` sau autovacuum → planner chọn Seq Scan, test index fail (Day 47).
9. Bỏ `ORDER BY` khi khoá mà test vẫn xanh — do plan, không do code (Day 48A).
10. Commit một nửa khi giữ nhiều ghế; FK deferred biến 409 thành 500 (Day 48A).
11. `UPDATE … SET booking_id = NULL … RETURNING booking_id` trả giá trị **mới** (NULL) → join rỗng (Day 48B, câu đối chứng).
12. Nhiều hold cùng hạn được quét theo `id` (UUID ngẫu nhiên), không theo thứ tự tạo trong test (Day 48B).
13. Index chỉ có `hold_expires_at` mà query `ORDER BY hold_expires_at, id` → vẫn Incremental Sort; cần `(hold_expires_at, id)` (Day 48B).

---

## 4. Câu hỏi tự kiểm tra

1. Vì sao `/ready` lỗi không được làm container restart?
2. Outbox giải quyết chặng nào mà DLQ không giải quyết được? Đánh đổi của outbox là gì?
3. Khi nào dùng OCC, khi nào dùng `SKIP LOCKED`, khi nào phải chờ khoá theo thứ tự?
4. Vì sao bắt `23505` trong transaction lại nguy hiểm, và `ON CONFLICT DO NOTHING` khác gì?
5. Query phụ "chỉ để chọn mã lỗi" làm lộ dữ liệu như thế nào nếu không có scope?
6. Expand/backfill/contract khác gì một migration `ALTER ... NOT NULL` thẳng? Vì sao contract nên **từ chối** thay vì xoá?
7. Vì sao `CLOSED`/`DEPARTED` không lưu vào DB mà dẫn xuất từ đồng hồ?
8. Một mutation sống sót nói lên điều gì?
9. Vì sao tồn kho ghế do job xử lý, còn trạng thái booking thì suy ra khi đọc?
10. Huỷ đúng tại giây hết hạn trả gì? Vì sao không để "huỷ thắng khi dòng còn ghi HELD"?

---

## 5. Tiếp theo

**Bước 6 phase D**: thanh toán giả lập với Idempotency-Key. Câu `HELD → CONFIRMED` dùng phía `hold_expires_at > now` của BR-BOOK-10 và có race test thanh toán vs hết hạn (mục 2.4).

Liên quan: [race-conditions/](./race-conditions/README.md), [interview/](./interview/README.md), [use-cases/](./use-cases/README.md); note tiếng Anh [hold-expiry-and-time-boundaries.md](../hold-expiry-and-time-boundaries.md), [all-or-nothing-holds-and-lock-ordering.md](../all-or-nothing-holds-and-lock-ordering.md), [object-level-authorization.md](../object-level-authorization.md), [exclusion-constraints.md](../exclusion-constraints.md), [outbox-and-relay.md](../outbox-and-relay.md); ADR-004/005/007/008, `.cursor/progress/DAY-*.md`.

# 15 — Báo cáo nhiều câu SQL và snapshot

Day 53, Decision 19.
- **Code:** `api/src/reports/postgres/postgres-admin-reports.ts` (manifest),
  `api/src/reports/postgres/admin-reports-sql.ts`.
- **Test:** `api/tests/integration/postgres-admin-reports-snapshot.integration.test.ts`.
- **Note tiếng Anh:** `docs/learnings/report-snapshots-and-query-shaped-indexes.md`.

## Vấn đề

Đây không phải race giữa hai lần **ghi**, mà giữa một lần **đọc nhiều câu** và một lần ghi xen vào
giữa. Manifest có hai câu:
1. Chuyến bay kèm số ghế `BOOKED` theo hạng.
2. Danh sách hành khách `CONFIRMED`.

Ở READ COMMITTED, **mỗi câu lệnh** có snapshot riêng. Nếu một booking 2 người bị huỷ và commit đúng
giữa hai câu, báo cáo hiện "3 ghế bán" phía trên danh sách 1 người. Không dòng nào trong database
sai, chỉ có **báo cáo** sai.

## Cách xử lý

| Báo cáo | Cách | Vì sao |
|---|---|---|
| Tỷ lệ lấp đầy, một trang audit | **Một câu** SQL | Một câu thì chỉ có một snapshot |
| Manifest (2 câu) | Transaction **`REPEATABLE READ READ ONLY`** | Mọi câu thấy snapshot chụp ở câu đầu |

- **`READ ONLY`**: nếu có câu ghi nào lọt vào báo cáo, câu đó lỗi ngay.
- **Không cần thử lại**: transaction chỉ đọc ở REPEATABLE READ trong Postgres **không bao giờ** gặp
  lỗi serialization. Lỗi đó chỉ xảy ra khi transaction **ghi** đụng phải bản đã bị đổi.
- **Mở transaction riêng trong adapter**, `TransactionRunner` không đổi. Nếu bị gọi bên trong một
  transaction khác thì ném `NestedTransactionError`, vì khi đó nó không kiểm soát được snapshot.

## Thí nghiệm (cổng chặn đặt giữa hai câu)

| Kịch bản | Kết quả |
|---|---|
| Adapter (RR RO): dừng sau câu 1 → huỷ booking 2 người và commit → chạy tiếp | **3 bán, 3 hành khách**: cả báo cáo phản ánh thế giới **trước** lúc huỷ. Đọc lại sau đó thì thấy 1 và 1. |
| Đối chứng (chỉ trong test): hai câu y hệt nhưng ở READ COMMITTED | **3 bán, 1 hành khách**: tự mâu thuẫn |
| Load factor (1 câu): 20 lần đọc chạy song song với 10 luồng giữ, huỷ, đặt lại | Mọi lần đọc đều có `trống + giữ + bán = tổng` |

- **Mutation:** đổi adapter sang `READ COMMITTED` thì test fail (`actual 1, expected 3`).
- Chạy cả file 10 lần liên tiếp, lần nào cũng xanh.

## Cái giá: snapshot dài cản vacuum

Khi transaction REPEATABLE READ còn mở, Postgres không được dọn các phiên bản dòng cũ mà snapshot
đó có thể còn cần. Một báo cáo chạy vài phút (ví dụ xuất cả năm audit) sẽ giữ rác của **cả
database** trong suốt thời gian đó. Vì vậy mọi báo cáo đều có trần:
- Manifest: một chuyến bay, tối đa 900 ghế.
- Tỷ lệ lấp đầy: 31 ngày và 50 chuyến mỗi trang.
- Audit: 31 ngày hoặc một đối tượng, 100 dòng mỗi trang.

## Bài học

- **Nhất quán của báo cáo** là chuyện khác **nhất quán của dữ liệu**. Dữ liệu đúng hết, báo cáo
  vẫn có thể sai.
- Test được điều này cần **cổng chặn giữa hai câu**. Chạy song song thông thường gần như không bao
  giờ rơi đúng khe hở đó.
- Ở bộ test integration, một test có cổng chặn mà fail giữa chừng sẽ để **transaction còn mở**,
  khiến `TRUNCATE` của test sau chờ mãi. Vì vậy `test:integration` có `--test-timeout` và
  `--test-force-exit`.

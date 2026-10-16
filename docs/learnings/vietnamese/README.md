# Learnings tiếng Việt

Thư mục riêng cho ghi chú **bằng tiếng Việt**, dùng để ôn lại nhanh và chuẩn bị phỏng vấn.
Các note tiếng Anh ở thư mục cha (`docs/learnings/*.md`) vẫn là bản gốc đi sâu từng kỹ thuật;
ở đây là bản tóm lược, theo kiểu "hỏi gì → trả lời gì → code ở đâu".

Cập nhật đến **Day 48A** (2026-10-16).

**Quy tắc:** cứ xong một ngày implement là cập nhật thư mục này (ghi trong `CLAUDE.md`, mục
"After a day is completed"): thêm dòng vào dòng thời gian, file race condition / phỏng vấn / use case
/ migration mới nếu ngày đó có, rồi đổi dòng "Cập nhật đến" ở trên.

## Cấu trúc

```text
vietnamese/
├── on-tap-nhanh-day-01-48a.md      bản đồ tổng: dòng thời gian Day 1 → 48A, bẫy đã gặp
├── race-conditions/                từng cách chống race condition trong project
│   ├── README.md                   bảng chọn kỹ thuật theo tình huống
│   ├── 01-occ-conditional-update.md
│   ├── 02-unique-va-exclusion-constraint.md
│   ├── 03-compare-and-set-trang-thai.md
│   ├── 04-skip-locked-va-cho-khoa.md
│   ├── 05-giu-nhieu-ghe-tat-ca-hoac-khong.md
│   ├── 06-cach-test-race-condition.md
│   └── 07-huy-va-dat-lai-dong-thoi.md
├── interview/                      câu hỏi phỏng vấn + câu trả lời dựa trên project
│   ├── README.md                   cách dùng + "câu chuyện 2 phút" về project
│   ├── kien-truc-va-thiet-ke.md
│   ├── database-va-transaction.md
│   ├── concurrency.md
│   ├── messaging-va-outbox.md
│   ├── bao-mat.md
│   ├── testing.md
│   └── van-hanh-docker-va-observability.md
├── migrations/                     thay đổi schema an toàn
│   ├── README.md                   nguyên tắc: expand → backfill → contract, từ chối không xoá
│   └── danh-sach.md                21 migration: làm gì, vì sao
└── use-cases/                      từng use case: input → luồng → outcome → HTTP
    ├── README.md                   bảng tất cả endpoint
    ├── flights.md
    ├── bookings.md
    ├── reference-data.md
    ├── identity.md
    └── background-jobs-va-consumer.md
```

## Đọc theo mục đích

| Muốn | Đọc |
|---|---|
| Nhớ lại cả project trong 10 phút | [on-tap-nhanh-day-01-48a.md](./on-tap-nhanh-day-01-48a.md) |
| Ôn race condition | [race-conditions/README.md](./race-conditions/README.md) |
| Chuẩn bị phỏng vấn | [interview/README.md](./interview/README.md) |
| Trả lời "endpoint X làm gì, lỗi gì" | [use-cases/README.md](./use-cases/README.md) |
| Nhớ schema thay đổi thế nào, vì sao | [migrations/README.md](./migrations/README.md) |

Quy ước: thuật ngữ kỹ thuật giữ tiếng Anh (`SKIP LOCKED`, outbox, BOLA…); đường dẫn code tính từ
gốc repo.

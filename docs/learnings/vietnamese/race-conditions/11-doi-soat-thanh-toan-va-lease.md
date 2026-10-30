# 11 — Đối soát thanh toán: kết quả không rõ, lease, một pha 3 dùng chung

Day 49C. Code: `api/src/payments/reconcile-payments.ts` (`createReconcilePayments`),
`api/src/payments/settle-payment.ts` (`createSettlePayment` — pha 3 dùng chung),
`api/src/payments/postgres/postgres-payment-repository.ts` (`claimDue`, `reschedule`),
`api/src/payments/simulated-payment-gateway.ts` (timeout + token lỗi).
Test: `api/tests/integration/postgres-payment-reconciliation.integration.test.ts` (6 kịch bản + 3b, 2 race + control).
Quyết định: domain-model **Decision 15**, **BR-PAY-08..10**; **ADR-010**.
Note tiếng Anh: [payments-and-idempotency-keys.md](../../payments-and-idempotency-keys.md), mục "Day 49C".

## Vấn đề

Gọi gateway có **ba** kết quả: thành công, bị từ chối, **không rõ** (timeout, mất kết nối, crash ngay
sau khi gửi). "Không rõ" nghĩa là provider có thể đã trừ, chưa trừ, hoặc **sẽ** trừ khi request kẹt
trên mạng tới muộn. Ba loại race mới:

1. **Đoán sai**: coi "không rõ" là thất bại → khách trả lại → trừ hai lần.
2. **Job giẫm lên request đang sống**: payment `PROCESSING` có thể đang được request xử lý (provider chậm).
3. **Hai instance job cùng lấy một payment**: job không được giữ khoá khi gọi gateway (ADR-009), nên
   `SKIP LOCKED` chỉ che được lúc claim — commit xong là khoá mất.

## Cách xử lý

```text
Request: pha 1 ghi PROCESSING, next_attempt_at = now + timeout + 30 s
         gateway trả unknown → 202, KHÔNG lưu vào key, KHÔNG FAILED

Job (mỗi 30 s):
  tx ngắn: WITH due AS (SELECT … WHERE status IN (PROCESSING, REFUND_PENDING)
                         AND next_attempt_at <= now ORDER BY … LIMIT n FOR UPDATE SKIP LOCKED)
           UPDATE … SET next_attempt_at = now + lease, attempts = attempts + 1     COMMIT
  không tx: PROCESSING → charge(cùng paymentId)  |  REFUND_PENDING → refund        (song song trong lô)
  tx ngắn mỗi payment: SettlePayment (pha 3 của request) | REFUNDED | REFUND_FAILED | lùi lịch
```

- **Charge lại cùng id, không chỉ hỏi**: id là idempotency key phía provider → có rồi thì trả kết quả
  cũ, chưa có thì trừ bây giờ; sau lời gọi chỉ còn **một** kết quả. "Chỉ hỏi" mà nhận "không tìm thấy"
  rồi đánh `FAILED` → request kẹt tới sau vẫn trừ → DB nói thất bại, tiền đã mất.
- **Ba hàng rào, mỗi cái chặn một thứ**:
  - *Ngưỡng tuổi* (timeout + 30 s): request sống chắc chắn đã xong → **giảm xác suất** đụng nhau.
  - *Lease* (claim đẩy `next_attempt_at`): instance khác bỏ qua trong lúc gọi gateway → **giảm lời gọi trùng**.
  - *Chuyển trạng thái có điều kiện* (`WHERE status = 'PROCESSING'`): nếu vẫn đụng, bên sau throw và
    rollback cả confirm booking → **bảo đảm đúng**. Idempotency của provider làm lời gọi trùng vô hại về tiền.
- **Gọi song song trong lô**: tuần tự 20 × timeout có thể dài hơn lease của payment cuối.
- **Refund có giới hạn**: 1, 2, 4, 8 phút; lần 5 hoặc `retryable: false` → `REFUND_FAILED` + log error.
  `PROCESSING` thì không bao giờ bị job đặt trạng thái cuối — đó sẽ là đoán.

## Đo được (file chạy 10 lần liên tiếp, 10/10 xanh, 12/12 mỗi lần)

| Thí nghiệm | Kết quả |
|---|---|
| Hai instance cùng lúc, 30 payment bỏ dở, có lease | 30 lời gọi job, mỗi payment đúng 1 (A 20 / B 10) |
| Control: không lease, instance 2 chạy sau khi instance 1 commit claim | **30 lời gọi trùng**; vẫn 1 lần trừ tiền và 1 lần settle mỗi payment |
| Mutation `next_attempt_at = least(now, now + lease)` | race hai instance fail 3/3; race request-vs-job vẫn xanh |
| Request sống (cổng trong `charge`) vs job | job confirm; request rollback (500), gửi lại key → `201` phát lại; 1 audit, 1 event, 0 refund |
| E2E `tok_lost_response`, timeout 4 s | `202` sau 4,0 s → cùng key `409` 7 ms → sau job `201` phát lại |

## Bẫy

- Mutation bỏ lease bằng comment làm tham số `$2` thừa → Postgres lỗi kiểu → **mọi** test fail. Một
  mutation phải chỉ đổi đúng hành vi cần thử.
- Fake gateway Day 49B **không nhớ** theo `paymentId` → khi job charge lại, test sẽ "thấy" trừ hai lần
  giả. Fake phải cư xử như provider thật (nhớ kết quả, ledger riêng).
- Dùng một Idempotency-Key cho 30 booking của cùng account → `422 IDEMPOTENCY_KEY_REUSED` (BR-PAY-02 đúng).

## Câu hỏi tự kiểm tra

1. Ba hàng rào trên, bỏ từng cái một thì chuyện gì xảy ra?
2. Vì sao job claim xong phải **commit** rồi mới gọi gateway? Lease thay thế cái gì?
3. Vì sao `PROCESSING` không có giới hạn số lần thử như refund?
4. Request thua job ở pha 3 trả `500` — vì sao chấp nhận được, và khách lấy kết quả bằng cách nào?

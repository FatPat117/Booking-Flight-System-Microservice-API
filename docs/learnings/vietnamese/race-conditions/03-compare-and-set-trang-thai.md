# 03 — Compare-and-set cho chuyển trạng thái

## Vấn đề

`OpenFlight` (Day 46): đọc flight → tính trạng thái hiệu lực → kiểm lifecycle có cho
`SCHEDULED → OPEN` không → ghi. Giữa lúc đọc và lúc ghi, một admin khác có thể đã đổi trạng thái
(mở rồi, hoặc huỷ). Ghi mù sẽ ghi đè.

## Cách xử lý

Phần kiểm luật (lifecycle, giờ khởi hành) làm bằng TypeScript trên dữ liệu đã đọc, **nhưng câu
ghi chỉ thành công nếu trạng thái vẫn đúng như lúc đọc**:

```ts
// postgres-flight-repository.ts — changeStatus(flightId, expected, next)
UPDATE flights SET status = :next WHERE id = :id AND status = :expected
// affected === 1 → "changed"
// affected === 0 → đọc lại chỉ để báo: "not-found" hoặc "status-changed" + trạng thái hiện tại
```

Use case trả `409 FLIGHT_STATUS_CHANGED` cho người thua — khác với `409 INVALID_FLIGHT_STATUS`
(luật không cho phép ngay từ đầu).

## Khác gì OCC ở file 01?

Cùng ý tưởng; khác ở chỗ **điều kiện nghiệp vụ phức tạp** (bảng lifecycle, giờ khởi hành) được
tính ngoài SQL, còn SQL chỉ giữ một điều kiện đơn giản "chưa ai đổi". Đây là OCC kiểu
"version check" với `status` đóng vai version.

## Trạng thái dẫn xuất từ đồng hồ — một cách **xoá bớt** race

Chỉ `SCHEDULED`, `OPEN`, `CANCELLED` được lưu. `CLOSED` (1 giờ trước khởi hành) và `DEPARTED`
được tính khi đọc (`effectiveFlightStatus` trong `api/src/flights/flight-lifecycle.ts`, ADR-008).
Nếu lưu `CLOSED` bằng job thì sẽ có race "job đóng bán" vs "người đang đặt vé". Không có job =
không có race đó. Câu giữ ghế tự kiểm cửa sổ bán vé ngay trong `WHERE`:
`flight.status = 'OPEN' AND flight.departure_at - interval '1 hour' > $now`.

## Test chứng minh

- Race test C (Day 46): 10 lệnh mở đồng thời → đúng 1 `opened`. Bỏ `AND status = :expected` →
  cả 10 đều "mở".

## Câu trả lời phỏng vấn 30 giây

> "Luật lifecycle kiểm bằng code cho dễ đọc, nhưng câu ghi kèm `AND status = :expected` — nếu
> có ai đổi trước thì UPDATE match 0 dòng và tôi trả 409 kèm trạng thái mới. Còn những trạng
> thái chỉ phụ thuộc thời gian thì tôi không lưu mà tính lúc đọc, để khỏi cần job và khỏi race
> với job."

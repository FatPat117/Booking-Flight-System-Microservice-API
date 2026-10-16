# Phỏng vấn: bảo mật

### 1. Authentication hoạt động thế nào?

**Trả lời:** Service `identity` đăng ký (bcrypt cost 12) và phát JWT `{sub, email, role}`, hết hạn
1 giờ. `api` verify bằng `JWT_SECRET` dùng chung (≥ 32 ký tự, thiếu thì fail khi khởi động).
JWT chỉ được **ký**, không mã hoá — ai cũng đọc được payload, nên không để gì nhạy cảm.
**Code:** `services/identity/src/login/`, `api/src/auth/verify-jwt.ts`, `require-role.ts`.

### 2. 401 khác 403 khác 404 thế nào trong project?

**Trả lời:**
- **401**: không biết bạn là ai (thiếu/sai/hết hạn token), có `WWW-Authenticate: Bearer`.
- **403**: biết bạn, nhưng **chức năng** này không dành cho role của bạn (user tạo chuyến bay,
  admin đặt vé hộ). Không lộ gì vì không liên quan dữ liệu cụ thể.
- **404**: tài nguyên không tồn tại **hoặc không thuộc về bạn** — hai trường hợp trả body giống
  hệt nhau.

### 3. BOLA là gì và bạn chống thế nào?

**Trả lời:** Broken Object Level Authorization (OWASP API #1): đổi id trên URL để xem/sửa dữ liệu
người khác. Middleware không chống được vì nó không biết ai sở hữu object. Tôi truyền
`BookingAccessScope = { kind: "owner", accountId } | { kind: "admin" }` vào **mọi query** của
repository. Là union nên "không lọc" phải được yêu cầu tường minh bằng `admin`, không thể lỡ
truyền `undefined`.
**Chi tiết tinh tế:** query phụ chỉ để **chọn mã lỗi** cũng phải có scope. Day 44 mutation bỏ scope
ở câu đọc phụ của `cancel()` → trả "409 đã huỷ" cho booking của người khác = lộ là booking đó tồn
tại.
**Code:** `api/src/auth/booking-access.ts`, `scopeFilter` trong `postgres-booking-repository.ts`.

### 4. Tra cứu booking bằng mã 6 ký tự có an toàn không?

**Trả lời:** Mã ngắn **dễ đoán hơn UUID** (32⁶ ≈ 1 tỷ), nên không dựa vào việc mã bí mật. Tra cứu
vẫn qua scope chủ sở hữu: mã của người khác → 404 giống mã không tồn tại; mã sai định dạng → 404
mà không chạm DB. Mã sinh bằng `crypto.randomInt`, bảng chữ bỏ `0/O/1/I` để đọc qua điện thoại.

### 5. Chống dò email/tài khoản?

**Trả lời:** Login sai email và sai mật khẩu trả **cùng một body** `401 INVALID_CREDENTIALS`; có
test so sánh hai body bằng nhau.

### 6. Mass assignment?

**Trả lời:** Đóng bằng **cấu trúc**: validation chỉ đọc email/password, `UserRepository.create()`
không có tham số role. Có test gửi `role: "admin"` khi đăng ký → vẫn lưu `user`. Lên admin chỉ qua
CLI vận hành `promote-to-admin`. Tương tự ở api: map field tường minh, không `...req.body`.

### 7. Không lộ dữ liệu ở endpoint công khai?

**Trả lời:** Sơ đồ ghế là public nhưng không có booking id, chủ sở hữu, tên khách. Test dùng
**allow-list**: duyệt mọi key ở mọi độ sâu và so với danh sách cho phép — field nào thêm sau mà
lỡ lộ sẽ làm test fail (chặt hơn test "không có field X"). Lỗi `SEATS_UNAVAILABLE` chỉ nói ghế
nào, không nói ai giữ.

### 8. Least privilege ở database?

**Trả lời:** Mỗi service một role không superuser, chỉ sở hữu database của mình,
`REVOKE CONNECT FROM PUBLIC`. Có test "not superuser" cho từng service.

### 9. Giới hạn bảo mật hiện tại (nói thật)?

**Trả lời:** Một claim role duy nhất, chưa có refresh token; đổi role chỉ có hiệu lực ở lần login
sau (token cũ giữ role cũ tới khi hết hạn); secret dùng chung qua `.env`, chưa có vault/rotation;
chưa rate limit (phase H).

# Use case: identity và xác thực

Service riêng `services/identity` (cổng 3001, database `identity_db`). Tách riêng vì nhiều service
sau này đều cần xác thực — không ai phải gọi qua API booking để login.

## RegisterUser — `POST /api/identity/register`

**Code:** `services/identity/src/register/register.ts`, `register-validation.ts`

```json
{ "email": "bob@example.com", "password": "Password123!" }
```

- Validation chỉ đọc `email`, `password` → gửi `role: "admin"` cũng bị bỏ (mass assignment đóng
  bằng cấu trúc: repository không có tham số role).
- Mật khẩu hash bằng bcrypt cost 12; response không bao giờ có `passwordHash`.
- Trùng email: check trước **và** `UNIQUE(email)` + bắt `23505` (race hai người đăng ký cùng lúc)
  → `duplicate_email` → 409 `EMAIL_ALREADY_REGISTERED`.

| Outcome | HTTP |
|---|---|
| `created` | 201 |
| `validation_failed` | 422 |
| `duplicate_email` | 409 |

## LoginUser — `POST /api/identity/login`

**Code:** `services/identity/src/login/login.ts`, `security/jwt-token-issuer.ts`

- Trả `{ accessToken, expiresIn }`; JWT `{ sub, email, role }`, hết hạn 1 giờ (`JWT_EXPIRES_IN`).
- Sai email và sai mật khẩu → **cùng** 401 `INVALID_CREDENTIALS` (chống dò email; có test so body).
- `TokenIssuer` là port → login không phụ thuộc thư viện jsonwebtoken.

## Promote admin (CLI vận hành)

`npm run promote-to-admin --workspace=@booking-flight-system/identity -- email@x.com`.
Không có API tự lên admin. **Token cũ giữ role cũ** tới khi hết hạn → login lại sau khi promote.

## Phía `api`: verify và phân quyền

**Code:** `api/src/auth/verify-jwt.ts`, `require-role.ts`, `booking-access.ts`

- `verifyJwt`: `401 MISSING_TOKEN` / `TOKEN_EXPIRED` / `INVALID_TOKEN`, kèm `WWW-Authenticate: Bearer`.
  User đã xác thực được đặt vào `AsyncLocalStorage` (request context).
- `requireRole("admin" | "user")` → 403 nếu sai role.
- `toActor(user)` → ai được ghi vào audit; `toBookingAccessScope(user)` → `owner` hoặc `admin`
  cho mọi query booking (chống BOLA).
- `GET /api/whoami` — route thăm dò, trả `userId`, `email`, `role`.

## Hạ tầng

- `JWT_SECRET` dùng chung giữa identity và api qua `.env` gốc (≥ 32 ký tự, fail fast).
- Mỗi service một role Postgres không superuser, `REVOKE CONNECT FROM PUBLIC`; có test "not superuser".

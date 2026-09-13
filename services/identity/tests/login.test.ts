import assert from "node:assert/strict";
import test from "node:test";

import jwt from "jsonwebtoken";
import request from "supertest";

import { createIdentityApp } from "../src/app.js";
import { createLoginUser } from "../src/login/login.js";
import { createRegisterUser } from "../src/register/register.js";
import { createJwtTokenIssuer } from "../src/security/jwt-token-issuer.js";
import type { PasswordHasher } from "../src/security/password-hasher.js";
import {
  DuplicateEmailError,
  type UserRecord,
  type UserRepository,
} from "../src/users/user-repository.js";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars!!";

function createMemoryUserRepository(): UserRepository {
  const users = new Map<string, UserRecord>();

  return {
    async findByEmail(email) {
      return users.get(email);
    },

    async create(input) {
      if (users.has(input.email)) {
        throw new DuplicateEmailError(input.email);
      }

      const record: UserRecord = {
        id: "user-fixed-id",
        email: input.email,
        passwordHash: input.passwordHash,
        role: "user",
        createdAt: new Date("2026-09-12T00:00:00.000Z"),
      };
      users.set(input.email, record);
      return record;
    },
  };
}

function createFakePasswordHasher(): PasswordHasher {
  return {
    async hash(password) {
      return `hashed:${password}`;
    },
    async compare(password, passwordHash) {
      return passwordHash === `hashed:${password}`;
    },
  };
}

test("JwtTokenIssuer issues a verifiable token with sub, email, and role", () => {
  const issuer = createJwtTokenIssuer({
    secret: TEST_JWT_SECRET,
    expiresIn: "1h",
  });

  const issued = issuer.issue({
    sub: "user-1",
    email: "alice@example.com",
    role: "user",
  });

  assert.equal(issued.expiresIn, "1h");
  assert.equal(typeof issued.accessToken, "string");

  const decoded = jwt.verify(issued.accessToken, TEST_JWT_SECRET) as {
    sub: string;
    email: string;
    role: string;
  };

  assert.equal(decoded.sub, "user-1");
  assert.equal(decoded.email, "alice@example.com");
  assert.equal(decoded.role, "user");
});

test("JwtTokenIssuer signature fails after token tampering", () => {
  const issuer = createJwtTokenIssuer({
    secret: TEST_JWT_SECRET,
    expiresIn: "1h",
  });

  const { accessToken } = issuer.issue({
    sub: "user-1",
    email: "alice@example.com",
    role: "admin",
  });

  const tampered = `${accessToken.slice(0, -4)}xxxx`;

  assert.throws(() => jwt.verify(tampered, TEST_JWT_SECRET));
});

test("login returns token for valid credentials", async () => {
  const userRepository = createMemoryUserRepository();
  const passwordHasher = createFakePasswordHasher();
  const tokenIssuer = createJwtTokenIssuer({
    secret: TEST_JWT_SECRET,
    expiresIn: "1h",
  });

  await userRepository.create({
    email: "alice@example.com",
    passwordHash: await passwordHasher.hash("secret123"),
  });

  const loginUser = createLoginUser({
    userRepository,
    passwordHasher,
    tokenIssuer,
  });

  const result = await loginUser({
    email: "alice@example.com",
    password: "secret123",
  });

  assert.equal(result.outcome, "authenticated");
  if (result.outcome !== "authenticated") {
    return;
  }

  const decoded = jwt.verify(result.token.accessToken, TEST_JWT_SECRET) as {
    sub: string;
    email: string;
    role: string;
  };
  assert.equal(decoded.sub, "user-fixed-id");
  assert.equal(decoded.email, "alice@example.com");
  assert.equal(decoded.role, "user");
});

test("login returns same invalid_credentials for unknown email and wrong password", async () => {
  const userRepository = createMemoryUserRepository();
  const passwordHasher = createFakePasswordHasher();
  const tokenIssuer = createJwtTokenIssuer({
    secret: TEST_JWT_SECRET,
    expiresIn: "1h",
  });

  await userRepository.create({
    email: "alice@example.com",
    passwordHash: await passwordHasher.hash("secret123"),
  });

  const loginUser = createLoginUser({
    userRepository,
    passwordHasher,
    tokenIssuer,
  });

  const missing = await loginUser({
    email: "missing@example.com",
    password: "secret123",
  });
  const wrongPassword = await loginUser({
    email: "alice@example.com",
    password: "wrong-password",
  });

  assert.equal(missing.outcome, "invalid_credentials");
  assert.equal(wrongPassword.outcome, "invalid_credentials");
});

test("POST /api/identity/login returns 200 with accessToken", async () => {
  const userRepository = createMemoryUserRepository();
  const passwordHasher = createFakePasswordHasher();
  const tokenIssuer = createJwtTokenIssuer({
    secret: TEST_JWT_SECRET,
    expiresIn: "1h",
  });

  const registerUser = createRegisterUser({
    userRepository,
    hashPassword: (password) => passwordHasher.hash(password),
  });
  const loginUser = createLoginUser({
    userRepository,
    passwordHasher,
    tokenIssuer,
  });
  const app = createIdentityApp({ registerUser, loginUser });

  await request(app)
    .post("/api/identity/register")
    .send({ email: "bob@example.com", password: "secret123" });

  const response = await request(app)
    .post("/api/identity/login")
    .send({ email: "bob@example.com", password: "secret123" });

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.accessToken, "string");
  assert.equal(response.body.expiresIn, "1h");
});

test("POST /api/identity/login returns 401 with identical body for bad email or password", async () => {
  const userRepository = createMemoryUserRepository();
  const passwordHasher = createFakePasswordHasher();
  const tokenIssuer = createJwtTokenIssuer({
    secret: TEST_JWT_SECRET,
    expiresIn: "1h",
  });

  const registerUser = createRegisterUser({
    userRepository,
    hashPassword: (password) => passwordHasher.hash(password),
  });
  const loginUser = createLoginUser({
    userRepository,
    passwordHasher,
    tokenIssuer,
  });
  const app = createIdentityApp({ registerUser, loginUser });

  await request(app)
    .post("/api/identity/register")
    .send({ email: "bob@example.com", password: "secret123" });

  const missing = await request(app)
    .post("/api/identity/login")
    .send({ email: "nobody@example.com", password: "secret123" });

  const wrong = await request(app)
    .post("/api/identity/login")
    .send({ email: "bob@example.com", password: "nope-nope" });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(missing.body, wrong.body);
  assert.equal(missing.body.error.code, "INVALID_CREDENTIALS");
});

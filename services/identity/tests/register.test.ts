import assert from "node:assert/strict";
import test from "node:test";

import { createIdentityApp } from "../src/app.js";
import { createRegisterUser } from "../src/register/register.js";
import type {
  UserRecord,
  UserRepository,
} from "../src/users/user-repository.js";
import { DuplicateEmailError } from "../src/users/user-repository.js";
import request from "supertest";

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
        id: crypto.randomUUID(),
        email: input.email,
        passwordHash: input.passwordHash,
        createdAt: new Date("2026-09-12T00:00:00.000Z"),
      };
      users.set(input.email, record);
      return record;
    },
  };
}

test("register creates a public user without passwordHash", async () => {
  const userRepository = createMemoryUserRepository();
  const registerUser = createRegisterUser({
    userRepository,
    hashPassword: async (password) => `hashed:${password}`,
  });

  const result = await registerUser({
    email: "Alice@Example.com",
    password: "secret123",
  });

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  assert.equal(result.user.email, "alice@example.com");
  assert.equal(result.user.createdAt, "2026-09-12T00:00:00.000Z");
  assert.equal(
    "passwordHash" in result.user,
    false,
    "passwordHash must never appear on PublicUser",
  );

  const stored = await userRepository.findByEmail("alice@example.com");
  assert.equal(stored?.passwordHash, "hashed:secret123");
});

test("register returns duplicate_email when email exists", async () => {
  const userRepository = createMemoryUserRepository();
  const registerUser = createRegisterUser({
    userRepository,
    hashPassword: async () => "hashed",
  });

  await registerUser({
    email: "dup@example.com",
    password: "secret123",
  });

  const second = await registerUser({
    email: "dup@example.com",
    password: "otherpass",
  });

  assert.equal(second.outcome, "duplicate_email");
});

test("register returns validation_failed for short password", async () => {
  const registerUser = createRegisterUser({
    userRepository: createMemoryUserRepository(),
    hashPassword: async () => "hashed",
  });

  const result = await registerUser({
    email: "ok@example.com",
    password: "short",
  });

  assert.equal(result.outcome, "validation_failed");
});

test("POST /api/identity/register returns 201 without password fields", async () => {
  const registerUser = createRegisterUser({
    userRepository: createMemoryUserRepository(),
    hashPassword: async () => "$2b$12$fakehash",
  });
  const app = createIdentityApp({ registerUser });

  const response = await request(app)
    .post("/api/identity/register")
    .send({ email: "bob@example.com", password: "secret123" });

  assert.equal(response.status, 201);
  assert.equal(response.body.email, "bob@example.com");
  assert.equal(response.body.passwordHash, undefined);
  assert.equal(response.body.password, undefined);
});

test("POST /api/identity/register returns 409 for duplicate email", async () => {
  const registerUser = createRegisterUser({
    userRepository: createMemoryUserRepository(),
    hashPassword: async () => "$2b$12$fakehash",
  });
  const app = createIdentityApp({ registerUser });

  await request(app)
    .post("/api/identity/register")
    .send({ email: "bob@example.com", password: "secret123" });

  const response = await request(app)
    .post("/api/identity/register")
    .send({ email: "bob@example.com", password: "secret123" });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "EMAIL_ALREADY_REGISTERED");
});

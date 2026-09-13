import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";

import { requireRole } from "../src/auth/require-role.js";
import {
  runWithRequestContext,
  setAuthenticatedUser,
} from "../src/observability/request-context.js";

type MockResponseState = {
  statusCode: number;
  body: unknown;
};

function createMockResponse(): {
  response: Response;
  state: MockResponseState;
} {
  const state: MockResponseState = {
    statusCode: 0,
    body: undefined,
  };

  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };

  return { response: response as unknown as Response, state };
}

test("requireRole returns 401 when authenticatedUser is missing", () => {
  const middleware = requireRole("admin");
  const { response, state } = createMockResponse();
  let nextCalled = false;

  runWithRequestContext({ requestId: "req-1" }, () => {
    middleware(
      {} as Request,
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "MISSING_TOKEN",
  );
});

test("requireRole returns 403 when role does not match", () => {
  const middleware = requireRole("admin");
  const { response, state } = createMockResponse();
  let nextCalled = false;

  runWithRequestContext({ requestId: "req-1" }, () => {
    setAuthenticatedUser({
      userId: "user-1",
      email: "user@example.com",
      role: "user",
    });

    middleware(
      {} as Request,
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 403);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "FORBIDDEN",
  );
});

test("requireRole calls next when role matches", () => {
  const middleware = requireRole("admin");
  const { response, state } = createMockResponse();
  let nextCalled = false;

  runWithRequestContext({ requestId: "req-1" }, () => {
    setAuthenticatedUser({
      userId: "admin-1",
      email: "admin@example.com",
      role: "admin",
    });

    middleware(
      {} as Request,
      response,
      (() => {
        nextCalled = true;
      }) as NextFunction,
    );
  });

  assert.equal(nextCalled, true);
  assert.equal(state.statusCode, 0);
});

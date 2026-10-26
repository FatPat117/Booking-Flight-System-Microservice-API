import assert from "node:assert/strict";
import test from "node:test";

import { requestFingerprint } from "../src/idempotency/request-fingerprint.js";

const BASE = {
  method: "POST",
  path: "/api/bookings/0b7e2a1c-0000-4000-8000-000000000001/payments",
  body: {
    paymentMethodToken: "tok_success",
    amount: { amount: 3_000_000, currency: "VND" },
  },
};

test("a fingerprint is a SHA-256 hex digest", () => {
  assert.match(requestFingerprint(BASE), /^[0-9a-f]{64}$/);
});

test("the same body with keys in another order, at any depth, has the same fingerprint", () => {
  const reordered = {
    path: BASE.path,
    body: {
      amount: { currency: "VND", amount: 3_000_000 },
      paymentMethodToken: "tok_success",
    },
    method: "POST",
  };

  assert.equal(requestFingerprint(reordered), requestFingerprint(BASE));
});

test("a changed value, method or path changes the fingerprint", () => {
  const fingerprint = requestFingerprint(BASE);

  for (const changed of [
    { ...BASE, body: { ...BASE.body, paymentMethodToken: "tok_decline" } },
    { ...BASE, body: { ...BASE.body, amount: { amount: 3_000_001, currency: "VND" } } },
    { ...BASE, method: "PUT" },
    { ...BASE, path: "/api/bookings/0b7e2a1c-0000-4000-8000-000000000002/payments" },
  ]) {
    assert.notEqual(requestFingerprint(changed), fingerprint);
  }
});

test("array order is part of the request", () => {
  assert.notEqual(
    requestFingerprint({ ...BASE, body: { items: [1, 2] } }),
    requestFingerprint({ ...BASE, body: { items: [2, 1] } }),
  );
});

test("a value of 3 and a string \"3\" are different requests", () => {
  assert.notEqual(
    requestFingerprint({ ...BASE, body: { amount: 3 } }),
    requestFingerprint({ ...BASE, body: { amount: "3" } }),
  );
});

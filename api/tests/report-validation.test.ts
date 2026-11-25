import assert from "node:assert/strict";
import test from "node:test";

import { validateAuditLogQuery, validateLoadFactorQuery } from "../src/reports/report-validation.js";

const codes = (result: { success: boolean; issues?: Array<{ code: string }> }) =>
  result.success ? [] : (result.issues ?? []).map((issue) => issue.code);

test("load factor: two local dates, an optional origin upper-cased, the default limit", () => {
  assert.deepEqual(validateLoadFactorQuery({ dateFrom: "2026-12-01", dateTo: "2026-12-31", origin: "sgn" }), {
    success: true,
    value: { query: { dateFrom: "2026-12-01", dateTo: "2026-12-31", origin: "SGN", limit: 20 }, cursor: undefined },
  });
});

test("load factor: at most 31 days; reversed, impossible, missing or repeated values are each reported", () => {
  assert.equal(validateLoadFactorQuery({ dateFrom: "2026-12-01", dateTo: "2026-12-31" }).success, true);
  assert.deepEqual(codes(validateLoadFactorQuery({ dateFrom: "2026-12-01", dateTo: "2027-01-01" })), ["DATE_RANGE_TOO_LONG"]);
  assert.deepEqual(codes(validateLoadFactorQuery({ dateFrom: "2026-12-02", dateTo: "2026-12-01" })), ["INVALID_DATE_RANGE"]);
  assert.deepEqual(codes(validateLoadFactorQuery({ dateFrom: "2026-02-30", dateTo: ["2026-03-01", "x"] })), [
    "INVALID_DATE",
    "INVALID_DATE",
  ]);
  assert.deepEqual(codes(validateLoadFactorQuery({})), ["MISSING_FIELD", "MISSING_FIELD"]);
  assert.deepEqual(
    codes(validateLoadFactorQuery({ dateFrom: "2026-12-01", dateTo: "2026-12-01", origin: "SG1", limit: "51" })),
    ["INVALID_AIRPORT_CODE", "INVALID_LIMIT"],
  );
});

test("audit log: a target alone is enough; a range alone is enough; neither is 422 FILTER_REQUIRED", () => {
  const target = validateAuditLogQuery({ targetType: "booking", targetId: "abc" });
  assert.equal(target.success && target.value.query.target?.id, "abc");
  const range = validateAuditLogQuery({ from: "2026-09-01T00:00:00+07:00", to: "2026-09-02T00:00:00Z" });
  assert.deepEqual(range.success && range.value.query.range, {
    from: "2026-08-31T17:00:00.000Z",
    to: "2026-09-02T00:00:00.000Z",
  });
  assert.deepEqual(codes(validateAuditLogQuery({ action: "BOOKING_CANCELLED" })), ["FILTER_REQUIRED"]);
});

test("audit log: halves of a pair, an unknown target type, a range over 31 days or backwards, a bad action and limit", () => {
  assert.deepEqual(codes(validateAuditLogQuery({ targetType: "booking" })), ["MISSING_FIELD"]);
  assert.deepEqual(codes(validateAuditLogQuery({ to: "2026-09-02T00:00:00Z" })), ["MISSING_FIELD"]);
  assert.deepEqual(codes(validateAuditLogQuery({ targetType: "account", targetId: "x" })), ["INVALID_TARGET_TYPE"]);
  assert.deepEqual(
    codes(validateAuditLogQuery({ from: "2026-09-01T00:00:00Z", to: "2026-10-02T00:00:00.001Z" })),
    ["TIME_RANGE_TOO_LONG"],
  );
  assert.equal(validateAuditLogQuery({ from: "2026-09-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }).success, true);
  assert.deepEqual(
    codes(validateAuditLogQuery({ from: "2026-09-02T00:00:00Z", to: "2026-09-02T00:00:00Z" })),
    ["INVALID_TIME_RANGE"],
  );
  assert.deepEqual(codes(validateAuditLogQuery({ from: "2026-09-01", to: "2026-09-02T00:00:00Z" })), ["INVALID_INSTANT"]);
  assert.deepEqual(
    codes(validateAuditLogQuery({ targetType: "flight", targetId: "x", action: "drop table", limit: "0" })),
    ["INVALID_FILTER", "INVALID_LIMIT"],
  );
});

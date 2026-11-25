import assert from "node:assert/strict";
import test from "node:test";

import { decodeReportCursor, encodeReportCursor } from "../src/reports/report-cursor.js";

const KEY = { at: "2026-09-01T10:05:00.000Z", id: "00000000-0000-4000-8000-000000000002" };
const SCOPE = { report: "audit-log", filter: ["booking", "b-1", null, null, null, null, null] };

test("a report cursor decodes to the key it was made from, for the same report and filter", () => {
  assert.deepEqual(decodeReportCursor(encodeReportCursor(KEY, SCOPE), SCOPE), KEY);
});

test("a report cursor made for another filter or another report is refused, not read as a wrong page", () => {
  const cursor = encodeReportCursor(KEY, SCOPE);
  assert.equal(decodeReportCursor(cursor, { ...SCOPE, filter: ["booking", "b-2", null, null, null, null, null] }), undefined);
  assert.equal(decodeReportCursor(cursor, { ...SCOPE, report: "load-factor" }), undefined);
});

test("a damaged, oversized or hand-edited report cursor is refused", () => {
  const cursor = encodeReportCursor(KEY, SCOPE);
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v: number; k: string[]; s: string };
  const edited = Buffer.from(JSON.stringify({ ...decoded, k: ["2027-01-01T00:00:00.000Z", KEY.id] })).toString("base64url");

  assert.equal(decodeReportCursor(edited, SCOPE), undefined);
  // One character changed in the middle (a trailing one only adds bits base64 drops).
  const middle = Math.floor(cursor.length / 2);
  const damaged = cursor.slice(0, middle) + (cursor[middle] === "A" ? "B" : "A") + cursor.slice(middle + 1);
  assert.equal(decodeReportCursor(damaged, SCOPE), undefined);
  assert.equal(decodeReportCursor("not base64!", SCOPE), undefined);
  assert.equal(decodeReportCursor("a".repeat(513), SCOPE), undefined);
});

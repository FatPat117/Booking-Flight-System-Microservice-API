import assert from "node:assert/strict";
import test from "node:test";

import { resolveCorrelationId } from "../src/outbox/resolve-correlation-id.js";

test("resolveCorrelationId prefers requestId when present", () => {
  assert.equal(
    resolveCorrelationId("req-123", "event-456"),
    "req-123",
  );
});

test("resolveCorrelationId falls back to eventId when requestId is undefined", () => {
  assert.equal(resolveCorrelationId(undefined, "event-456"), "event-456");
});

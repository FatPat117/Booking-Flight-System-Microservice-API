import assert from "node:assert/strict";
import test from "node:test";

import { createFlightCreatedConsumer } from "../src/messaging/flight-created-consumer.js";
import type { Logger, LogFields } from "../src/observability/logger.js";

function createMemoryLogger() {
  const entries: Array<{
    level: string;
    message: string;
    fields?: LogFields;
  }> = [];

  const logger: Logger = {
    info(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "info", message }
          : { level: "info", message, fields },
      );
    },
    warn(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "warn", message }
          : { level: "warn", message, fields },
      );
    },
    error(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "error", message }
          : { level: "error", message, fields },
      );
    },
  };

  return { logger, entries };
}

const validPayload = {
  type: "flight.created",
  occurredAt: "2026-08-11T00:00:00.000Z",
  flight: {
    id: "flight-1",
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-12T01:00:00.000Z",
    arrivalAt: "2026-08-12T03:00:00.000Z",
    priceInCents: 1_500_000,
    currency: "VND",
    availableSeats: 100,
  },
};

test("flightCreatedConsumer processes a valid fat event", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createFlightCreatedConsumer({ logger });

  const result = await handler(validPayload);

  assert.deepEqual(result, { outcome: "processed" });
  assert.ok(
    entries.some(
      (entry) =>
        entry.message === "flight_created_consumed" &&
        entry.fields?.flightId === "flight-1",
    ),
  );
});

test("flightCreatedConsumer rejects invalid payloads without throwing", async () => {
  const { logger } = createMemoryLogger();
  const handler = createFlightCreatedConsumer({ logger });

  const cases: unknown[] = [
    null,
    "not-an-object",
    { type: "other.event" },
    { type: "flight.created", occurredAt: "", flight: validPayload.flight },
  ];

  for (const payload of cases) {
    const result = await handler(payload);
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") {
      assert.ok(result.reason.length > 0);
    }
  }
});

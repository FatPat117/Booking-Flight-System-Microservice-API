import assert from "node:assert/strict";
import test from "node:test";

import { createBookingCreatedConsumer } from "../src/messaging/booking-created-consumer.js";
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
  eventId: "event-booking-123",
  type: "booking.created",
  occurredAt: "2026-09-06T00:00:00.000Z",
  booking: {
    id: "booking-1",
    flightId: "flight-1",
    passengerName: "Alice",
    createdAt: "2026-09-06T00:00:00.000Z",
  },
};

test("bookingCreatedConsumer processes a valid event", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingCreatedConsumer({ logger });

  const result = await handler(validPayload);

  assert.deepEqual(result, { outcome: "processed" });
  assert.ok(
    entries.some(
      (entry) =>
        entry.message === "booking_created_consumed" &&
        entry.fields?.eventId === "event-booking-123" &&
        entry.fields?.bookingId === "booking-1" &&
        entry.fields?.flightId === "flight-1",
    ),
  );
});

test("bookingCreatedConsumer rejects invalid payloads without throwing", async () => {
  const { logger } = createMemoryLogger();
  const handler = createBookingCreatedConsumer({ logger });

  const cases: unknown[] = [
    null,
    "not-an-object",
    { type: "other.event" },
    {
      type: "booking.created",
      occurredAt: "2026-09-06T00:00:00.000Z",
      booking: validPayload.booking,
    },
    {
      eventId: "",
      type: "booking.created",
      occurredAt: "2026-09-06T00:00:00.000Z",
      booking: validPayload.booking,
    },
  ];

  for (const payload of cases) {
    const result = await handler(payload);
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") {
      assert.ok(result.reason.length > 0);
    }
  }
});

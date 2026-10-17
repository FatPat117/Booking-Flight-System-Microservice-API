import assert from "node:assert/strict";
import test from "node:test";

import { createBookingExpiredConsumer } from "../src/messaging/booking-expired-consumer.js";
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

const validBooking = {
  id: "booking-1",
  reference: "K7Q4PZ",
  flightId: "flight-1",
  holdExpiresAt: "2026-10-16T00:15:00.000Z",
  seats: ["12A", "12B"],
};

const validPayload = {
  eventId: "event-expired-1",
  correlationId: "event-expired-1",
  type: "booking.expired",
  occurredAt: "2026-10-16T00:15:42.000Z",
  booking: validBooking,
};

test("bookingExpiredConsumer processes a valid event and logs the reference and seat count", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingExpiredConsumer({ logger });

  const result = await handler(validPayload);

  assert.deepEqual(result, { outcome: "processed" });
  assert.deepEqual(entries, [
    {
      level: "info",
      message: "booking_expired_consumed",
      fields: {
        eventId: "event-expired-1",
        correlationId: "event-expired-1",
        bookingId: "booking-1",
        reference: "K7Q4PZ",
        flightId: "flight-1",
        seatCount: 2,
        holdExpiresAt: "2026-10-16T00:15:00.000Z",
        occurredAt: "2026-10-16T00:15:42.000Z",
      },
    },
  ]);
});

test("bookingExpiredConsumer rejects invalid payloads without throwing", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingExpiredConsumer({ logger });

  const cases: unknown[] = [
    null,
    "not-an-object",
    // A held event on the wrong queue is rejected, not half-read.
    { ...validPayload, type: "booking.held" },
    { ...validPayload, correlationId: "" },
    { ...validPayload, booking: null },
    { ...validPayload, booking: { ...validBooking, reference: undefined } },
    { ...validPayload, booking: { ...validBooking, holdExpiresAt: "" } },
    { ...validPayload, booking: { ...validBooking, seats: [] } },
    { ...validPayload, booking: { ...validBooking, seats: ["12A", 7] } },
  ];

  for (const payload of cases) {
    const result = await handler(payload);
    assert.equal(result.outcome, "rejected");
    if (result.outcome === "rejected") {
      assert.ok(result.reason.length > 0);
    }
  }
  assert.equal(entries.length, 0);
});

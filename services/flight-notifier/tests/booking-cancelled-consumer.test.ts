import assert from "node:assert/strict";
import test from "node:test";

import { createBookingCancelledConsumer } from "../src/messaging/booking-cancelled-consumer.js";
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
  seats: ["12A", "12B"],
};

const validRefund = {
  paymentId: "payment-1",
  amount: { amount: 3_000_000, currency: "VND" },
};

const validPayload = {
  eventId: "event-cancelled-1",
  correlationId: "request-1",
  type: "booking.cancelled",
  occurredAt: "2026-10-16T00:05:00.000Z",
  booking: validBooking,
  refund: validRefund,
};

test("bookingCancelledConsumer processes a paid cancel and logs the reference, seat count and the refund started", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingCancelledConsumer({ logger });

  const result = await handler(validPayload);

  assert.deepEqual(result, { outcome: "processed" });
  assert.deepEqual(entries, [
    {
      level: "info",
      message: "booking_cancelled_consumed",
      fields: {
        eventId: "event-cancelled-1",
        correlationId: "request-1",
        bookingId: "booking-1",
        reference: "K7Q4PZ",
        flightId: "flight-1",
        seatCount: 2,
        refundPaymentId: "payment-1",
        refundAmount: 3_000_000,
        occurredAt: "2026-10-16T00:05:00.000Z",
      },
    },
  ]);
});

test("bookingCancelledConsumer processes an unpaid cancel: refund null", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingCancelledConsumer({ logger });

  const result = await handler({ ...validPayload, refund: null });

  assert.deepEqual(result, { outcome: "processed" });
  assert.equal(entries[0]?.fields?.refundPaymentId, null);
  assert.equal(entries[0]?.fields?.refundAmount, null);
});

test("bookingCancelledConsumer rejects invalid payloads, including the pre-Day 50 shape, without throwing", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingCancelledConsumer({ logger });

  const { refund: _refund, ...withoutRefund } = validPayload;
  const cases: unknown[] = [
    null,
    "not-an-object",
    { ...validPayload, type: "booking.expired" },
    { ...validPayload, eventId: "" },
    { ...validPayload, booking: null },
    { ...validPayload, booking: { ...validBooking, reference: "" } },
    { ...validPayload, booking: { ...validBooking, seats: [] } },
    // A missing refund is a producer bug, not "unpaid".
    withoutRefund,
    { ...validPayload, refund: { paymentId: "payment-1" } },
    { ...validPayload, refund: { ...validRefund, amount: { amount: 1.5, currency: "VND" } } },
    // What the outbox sent from Day 28 to Day 49C.
    {
      eventId: "old-1",
      correlationId: "old-1",
      type: "booking.cancelled",
      occurredAt: "2026-10-01T00:00:00.000Z",
      booking: { id: "booking-1", flightId: "flight-1" },
    },
  ];

  for (const payload of cases) {
    const result = await handler(payload);
    assert.equal(result.outcome, "rejected", JSON.stringify(payload));
  }
  assert.equal(entries.length, 0);
});

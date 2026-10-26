import assert from "node:assert/strict";
import test from "node:test";

import { createBookingConfirmedConsumer } from "../src/messaging/booking-confirmed-consumer.js";
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

const validPassenger = {
  name: "Nguyen Van A",
  seat: "12A",
  fareClass: "ECONOMY",
  price: { amount: 1_500_000, currency: "VND" },
};

const validBooking = {
  id: "booking-1",
  reference: "K7Q4PZ",
  flightId: "flight-1",
  passengers: [validPassenger, { ...validPassenger, name: "Tran Thi B", seat: "12B" }],
  total: { amount: 3_000_000, currency: "VND" },
};

const validPayload = {
  eventId: "event-confirmed-1",
  correlationId: "request-1",
  type: "booking.confirmed",
  occurredAt: "2026-10-16T00:05:00.000Z",
  booking: validBooking,
  payment: { id: "payment-1", amount: { amount: 3_000_000, currency: "VND" } },
};

test("bookingConfirmedConsumer processes a valid event and logs the reference and amount, no names", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingConfirmedConsumer({ logger });

  const result = await handler(validPayload);

  assert.deepEqual(result, { outcome: "processed" });
  assert.deepEqual(entries, [
    {
      level: "info",
      message: "booking_confirmed_consumed",
      fields: {
        eventId: "event-confirmed-1",
        correlationId: "request-1",
        bookingId: "booking-1",
        reference: "K7Q4PZ",
        flightId: "flight-1",
        passengerCount: 2,
        paymentId: "payment-1",
        amount: 3_000_000,
        currency: "VND",
        occurredAt: "2026-10-16T00:05:00.000Z",
      },
    },
  ]);
});

test("bookingConfirmedConsumer rejects invalid payloads without throwing", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingConfirmedConsumer({ logger });

  const cases: unknown[] = [
    null,
    "not-an-object",
    // A held event on the wrong queue is rejected, not half-read.
    { ...validPayload, type: "booking.held" },
    { ...validPayload, eventId: "" },
    { ...validPayload, booking: null },
    { ...validPayload, booking: { ...validBooking, reference: undefined } },
    { ...validPayload, booking: { ...validBooking, passengers: [] } },
    // A confirmed booking always has prices: no Day 48A shape to accept.
    {
      ...validPayload,
      booking: { ...validBooking, passengers: [{ name: "A", seat: "12A" }] },
    },
    { ...validPayload, booking: { ...validBooking, total: { amount: 1.5, currency: "VND" } } },
    { ...validPayload, payment: undefined },
    { ...validPayload, payment: { id: "payment-1" } },
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

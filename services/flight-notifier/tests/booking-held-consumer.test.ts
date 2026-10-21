import assert from "node:assert/strict";
import test from "node:test";

import { createBookingHeldConsumer } from "../src/messaging/booking-held-consumer.js";
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
  createdAt: "2026-10-16T00:00:00.000Z",
  holdExpiresAt: "2026-10-16T00:15:00.000Z",
  passengers: [
    { name: "Alice", seat: "12A" },
    { name: "Bob", seat: "12B" },
  ],
};

const validPayload = {
  eventId: "event-held-1",
  correlationId: "corr-held-1",
  type: "booking.held",
  occurredAt: "2026-10-16T00:00:00.000Z",
  booking: validBooking,
};

test("bookingHeldConsumer processes a valid event and logs the reference, not the names", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingHeldConsumer({ logger });

  const result = await handler(validPayload);

  assert.deepEqual(result, { outcome: "processed" });
  assert.deepEqual(entries, [
    {
      level: "info",
      message: "booking_held_consumed",
      fields: {
        eventId: "event-held-1",
        correlationId: "corr-held-1",
        bookingId: "booking-1",
        reference: "K7Q4PZ",
        flightId: "flight-1",
        passengerCount: 2,
        holdExpiresAt: "2026-10-16T00:15:00.000Z",
        occurredAt: "2026-10-16T00:00:00.000Z",
      },
    },
  ]);
});

const pricedBooking = {
  ...validBooking,
  passengers: [
    { name: "Alice", seat: "1A", fareClass: "BUSINESS", price: { amount: 4_200_000, currency: "VND" } },
    { name: "Bob", seat: "12B", fareClass: "ECONOMY", price: { amount: 1_500_000, currency: "VND" } },
  ],
  total: { amount: 5_700_000, currency: "VND" },
};

test("bookingHeldConsumer processes the Day 49A shape and logs the total", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingHeldConsumer({ logger });

  const result = await handler({ ...validPayload, booking: pricedBooking });

  assert.deepEqual(result, { outcome: "processed" });
  assert.equal(entries[0]?.fields?.total, 5_700_000);
  assert.equal(entries[0]?.fields?.currency, "VND");
});

test("bookingHeldConsumer rejects prices that are present but malformed", async () => {
  const { logger } = createMemoryLogger();
  const handler = createBookingHeldConsumer({ logger });
  const [alice, bob] = pricedBooking.passengers;

  const cases: unknown[] = [
    { ...pricedBooking, total: 5_700_000 },
    { ...pricedBooking, total: { amount: 5.7, currency: "VND" } },
    { ...pricedBooking, passengers: [{ ...alice, price: { amount: 4_200_000 } }, bob] },
    { ...pricedBooking, passengers: [{ ...alice, fareClass: "" }, bob] },
  ];

  for (const booking of cases) {
    const result = await handler({ ...validPayload, booking });
    assert.equal(result.outcome, "rejected", JSON.stringify(booking));
  }
});

test("bookingHeldConsumer rejects invalid payloads without throwing", async () => {
  const { logger, entries } = createMemoryLogger();
  const handler = createBookingHeldConsumer({ logger });

  const cases: unknown[] = [
    null,
    "not-an-object",
    // The old event on the wrong queue is rejected, not half-read.
    { ...validPayload, type: "booking.created" },
    { ...validPayload, booking: { ...validBooking, reference: undefined } },
    { ...validPayload, booking: { ...validBooking, holdExpiresAt: "" } },
    { ...validPayload, booking: { ...validBooking, passengers: [] } },
    { ...validPayload, booking: { ...validBooking, passengers: [null] } },
    {
      ...validPayload,
      booking: { ...validBooking, passengers: [{ name: "Alice" }] },
    },
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

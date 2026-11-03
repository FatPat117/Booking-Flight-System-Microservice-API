import assert from "node:assert/strict";
import test from "node:test";

import type { SeatPosition } from "../src/aircraft/seat-position.js";
import type { AuditRecordInput } from "../src/audit/audit-recorder.js";
import type { BookingRepository, ChangeSeatResult } from "../src/bookings/booking-repository.js";
import { createChangeSeat } from "../src/bookings/change-seat.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";
import { makeBooking } from "./fixtures/bookings.js";

const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");
const BOOKING = makeBooking({
  id: "b0b0b0b0-0000-4000-8000-000000000001",
  flightId: "f1f1f1f1-0000-4000-8000-000000000001",
  status: "CONFIRMED",
});
const ACCOUNT = BOOKING.ownerAccountId;
const SCOPE = { kind: "owner", accountId: ACCOUNT } as const;
const SEAT_5C: SeatPosition = { row: 5, letter: "C" };

/** A repository whose changeSeat answers `result`; every call is counted. */
function runtime(result: ChangeSeatResult) {
  const calls: string[] = [];
  const records: AuditRecordInput[] = [];
  const bookingRepository: BookingRepository = {
    ...createInMemoryBookingRepository({ flights: createInMemoryFlightStore() }),
    async changeSeat(bookingId, position, seat) {
      calls.push(`changeSeat ${bookingId} ${position} ${seat.row}${seat.letter}`);
      return result;
    },
    async findById(bookingId) {
      calls.push(`findById ${bookingId}`);
      return BOOKING;
    },
  };

  const changeSeat = createChangeSeat({
    bookingRepository,
    auditRecorder: {
      async record(input) {
        records.push(input);
      },
    },
    transactionRunner: createInMemoryTransactionRunner(),
    generateAuditId: () => "audit-1",
    getRequestId: () => "request-1",
    getCurrentTime: () => FIXED_TIME,
  });

  return { changeSeat, calls, records };
}

test("a changed seat is audited by the owner with position, from and to, and answers the booking as it now reads", async () => {
  const { changeSeat, records } = runtime({ outcome: "changed", from: "3B", to: "5C" });

  const result = await changeSeat(BOOKING.id, 2, SEAT_5C, SCOPE, { accountId: ACCOUNT });

  assert.deepEqual(result, { outcome: "changed", booking: BOOKING });
  assert.deepEqual(records, [
    {
      id: "audit-1",
      action: "BOOKING_SEAT_CHANGED",
      actor: { type: "account", id: ACCOUNT },
      target: { type: "booking", id: BOOKING.id },
      requestId: "request-1",
      occurredAt: FIXED_TIME.toISOString(),
      metadata: { position: 2, from: "3B", to: "5C" },
    },
  ]);
});

test("setting the seat a passenger already has answers the booking and records no audit", async () => {
  const { changeSeat, records } = runtime({ outcome: "unchanged" });

  assert.deepEqual(await changeSeat(BOOKING.id, 1, SEAT_5C, SCOPE, { accountId: ACCOUNT }), {
    outcome: "unchanged",
    booking: BOOKING,
  });
  assert.deepEqual(records, []);
});

test("a refusal is passed through as it is, with no audit and no read-back", async () => {
  const { changeSeat, calls, records } = runtime({
    outcome: "fare-class-mismatch",
    seatFareClass: "ECONOMY",
    targetFareClass: "BUSINESS",
  });

  assert.deepEqual(await changeSeat(BOOKING.id, 1, SEAT_5C, SCOPE, { accountId: ACCOUNT }), {
    outcome: "fare-class-mismatch",
    seatFareClass: "ECONOMY",
    targetFareClass: "BUSINESS",
  });
  assert.deepEqual(calls, [`changeSeat ${BOOKING.id} 1 5C`]);
  assert.deepEqual(records, []);
});

test("a malformed booking id is not-found, never sent to the repository", async () => {
  const { changeSeat, calls } = runtime({ outcome: "unchanged" });

  assert.deepEqual(await changeSeat("not-a-uuid", 1, SEAT_5C, SCOPE, { accountId: ACCOUNT }), {
    outcome: "not-found",
  });
  assert.deepEqual(calls, []);
});

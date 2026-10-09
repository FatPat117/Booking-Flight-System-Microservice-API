import assert from "node:assert/strict";
import test from "node:test";

import type {
  Booking,
  BookingAccessScope,
} from "../src/bookings/booking-repository.js";
import { createListBookings } from "../src/bookings/list-bookings.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
} from "./fakes/in-memory.js";

const FLIGHT_ID = "f1f1f1f1-0000-4000-8000-000000000001";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const SCOPE_A: BookingAccessScope = { kind: "owner", accountId: ACCOUNT_A };

function makeBooking(n: number, ownerAccountId: string): Booking {
  return {
    id: `b0b0b0b0-0000-4000-8000-00000000000${n}`,
    flightId: FLIGHT_ID,
    ownerAccountId,
    passengerName: `Passenger ${n}`,
    createdAt: `2026-07-2${n}T00:00:00.000Z`,
    status: "active",
  };
}

async function createRuntime() {
  const flights = createInMemoryFlightStore();
  await createInMemoryFlightRepository(flights).create({
    id: FLIGHT_ID,
    flightNumber: "VN123",
    origin: "SGN",
    destination: "HAN",
    departureAt: "2026-08-10T01:00:00.000Z",
    arrivalAt: "2026-08-10T03:00:00.000Z",
    priceInCents: 15_000_000,
    currency: "VND",
    availableSeats: 5,
  });
  const bookingRepository = createInMemoryBookingRepository({ flights });

  await bookingRepository.create(makeBooking(1, ACCOUNT_A));
  await bookingRepository.create(makeBooking(2, ACCOUNT_B));
  await bookingRepository.create(makeBooking(3, ACCOUNT_A));

  return createListBookings({ bookingRepository });
}

test("an owner lists only their own bookings, newest first, with pagination", async () => {
  const listBookings = await createRuntime();

  const result = await listBookings(SCOPE_A, {});

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") {
    return;
  }
  assert.deepEqual(
    result.items.map((booking) => booking.passengerName),
    ["Passenger 3", "Passenger 1"],
  );
  assert.deepEqual(result.pagination, {
    page: 1,
    pageSize: 20,
    totalItems: 2,
    totalPages: 1,
  });
});

test("an admin lists every account's bookings", async () => {
  const listBookings = await createRuntime();

  const result = await listBookings({ kind: "admin" }, {});

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") {
    return;
  }
  assert.equal(result.pagination.totalItems, 3);
});

test("page and pageSize use the shared pagination rules", async () => {
  const listBookings = await createRuntime();

  const second = await listBookings(SCOPE_A, { page: "2", pageSize: "1" });
  const invalid = await listBookings(SCOPE_A, { page: "0", pageSize: "101" });

  assert.equal(second.outcome, "success");
  if (second.outcome === "success") {
    assert.deepEqual(second.items.map((b) => b.passengerName), ["Passenger 1"]);
    assert.equal(second.pagination.totalPages, 2);
  }
  assert.equal(invalid.outcome, "validation_failed");
  if (invalid.outcome === "validation_failed") {
    assert.deepEqual(invalid.issues.map((issue) => issue.code), [
      "INVALID_PAGE",
      "INVALID_PAGE_SIZE",
    ]);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import type {
  BookingRepository,
  SeatHoldRequest,
} from "../src/bookings/booking-repository.js";
import {
  BookingReferenceExhaustedError,
  createCreateBooking,
  MAX_REFERENCE_ATTEMPTS,
} from "../src/bookings/create-booking.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import type { Actor, Flight } from "../src/types.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";
import {
  FIXTURE_FARES,
  FIXTURE_TWO_CLASS_AIRCRAFT_ID,
  makeFlight as makeFixtureFlight,
} from "./fixtures/flights.js";

const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");
const FLIGHT_ID = "f1f1f1f1-0000-4000-8000-000000000001";
const BOOKING_ID = "b0b0b0b0-0000-4000-8000-000000000001";
const REFERENCE = "K7Q4PZ";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACTOR_A: Actor = { accountId: ACCOUNT_A };

/** A request body with one passenger per name, no seats named. */
function passengers(...names: string[]) {
  return { passengers: names.map((name) => ({ name })) };
}

/** An OPEN flight departing in 2027, well after FIXED_TIME. */
function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return makeFixtureFlight({ id: FLIGHT_ID, availableSeats: 1, ...overrides });
}

function createCapturingAuditRecorder() {
  const records: AuditRecordInput[] = [];

  const auditRecorder: AuditRecorder = {
    async record(input) {
      records.push(input);
    },
  };

  return { auditRecorder, records };
}

function createCapturingOutboxRepository() {
  const entries: OutboxEntry[] = [];

  const outboxRepository: OutboxRepository = {
    async enqueue(entry) {
      entries.push(entry);
    },
    async findUnpublished() {
      return [];
    },
    async markPublished() {},
  };

  return { outboxRepository, entries };
}

async function createTestRuntime(availableSeats = 1) {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const transactionRunner = createInMemoryTransactionRunner();

  await flightRepository.create(makeFlight({ availableSeats }));

  return {
    flightRepository,
    bookingRepository,
    transactionRunner,
  };
}

test("creates a HELD booking for every passenger, with one audit row and one booking-held event", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime(3);
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(
    FLIGHT_ID,
    passengers(" Alice ", "Bob"),
    ACTOR_A,
  );

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  const economy = FIXTURE_FARES.ECONOMY;
  const seated = [
    { name: "Alice", seat: "1A", fareClass: "ECONOMY", price: economy },
    { name: "Bob", seat: "1B", fareClass: "ECONOMY", price: economy },
  ];
  assert.deepEqual(result.booking, {
    id: BOOKING_ID,
    reference: REFERENCE,
    flightId: FLIGHT_ID,
    ownerAccountId: ACCOUNT_A,
    passengers: seated,
    total: { amount: 3_000_000, currency: "VND" },
    createdAt: "2026-07-20T00:00:00.000Z",
    status: "HELD",
    // BR-BOOK-04: 15 minutes after FIXED_TIME.
    holdExpiresAt: "2026-07-20T00:15:00.000Z",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.eventType, "booking-held");
  assert.deepEqual(entries[0]?.payload, {
    eventId: "fixed-outbox-id",
    correlationId: "fixed-request-id",
    type: "booking.held",
    occurredAt: "2026-07-20T00:00:00.000Z",
    booking: {
      id: BOOKING_ID,
      reference: REFERENCE,
      flightId: FLIGHT_ID,
      createdAt: "2026-07-20T00:00:00.000Z",
      holdExpiresAt: "2026-07-20T00:15:00.000Z",
      passengers: seated,
      total: { amount: 3_000_000, currency: "VND" },
    },
  });
  assert.deepEqual(records, [
    {
      id: "fixed-audit-id",
      action: "BOOKING_CREATED",
      actor: { type: "account", id: ACCOUNT_A },
      target: { type: "booking", id: BOOKING_ID },
      requestId: "fixed-request-id",
      occurredAt: "2026-07-20T00:00:00.000Z",
      // No passenger names in the audit log.
      metadata: {
        flightId: FLIGHT_ID,
        reference: REFERENCE,
        passengerCount: 2,
        seats: "1A,1B",
        totalVnd: 3_000_000,
        holdExpiresAt: "2026-07-20T00:15:00.000Z",
        correlationId: "fixed-request-id",
      },
    },
  ]);
});

test("named seats are held as one chosen request and paired with passengers in request order", async () => {
  const { bookingRepository: inner, transactionRunner } = await createTestRuntime(6);
  const requests: SeatHoldRequest[] = [];
  const bookingRepository: BookingRepository = {
    ...inner,
    async holdSeats(flightId, bookingId, request, now) {
      requests.push(request);
      return inner.holdSeats(flightId, bookingId, request, now);
    },
  };
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createCapturingAuditRecorder().auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(
    FLIGHT_ID,
    {
      passengers: [
        { name: "Alice", seat: "1C" },
        { name: "Bob", seat: "1A" },
      ],
    },
    ACTOR_A,
  );

  assert.deepEqual(requests, [
    {
      kind: "chosen",
      seats: [
        { row: 1, letter: "C" },
        { row: 1, letter: "A" },
      ],
    },
  ]);
  assert.equal(result.outcome, "created");
  assert.deepEqual(
    result.outcome === "created" &&
      result.booking.passengers.map(({ name, seat }) => ({ name, seat })),
    [
      { name: "Alice", seat: "1C" },
      { name: "Bob", seat: "1A" },
    ],
  );
});

test("each passenger pays the fare of their own seat's class, and the total is the sum (BR-BOOK-03)", async () => {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  await flightRepository.create(
    makeFlight({ aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID, availableSeats: 30 }),
  );
  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const createBooking = createCreateBooking({
    bookingRepository: createInMemoryBookingRepository({ flights }),
    auditRecorder,
    outboxRepository,
    transactionRunner: createInMemoryTransactionRunner(),
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(
    FLIGHT_ID,
    {
      passengers: [
        { name: "Alice", seat: "1A" },
        { name: "Bob", seat: "3A" },
      ],
    },
    ACTOR_A,
  );

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }
  assert.deepEqual(
    result.booking.passengers.map(({ seat, fareClass, price }) => [seat, fareClass, price?.amount]),
    [
      ["1A", "BUSINESS", 4_200_000],
      ["3A", "ECONOMY", 1_500_000],
    ],
  );
  assert.deepEqual(result.booking.total, { amount: 5_700_000, currency: "VND" });
  const event = entries[0]?.payload as {
    booking: { passengers: Array<{ price: unknown }>; total: unknown };
  };
  assert.deepEqual(event.booking.passengers[0]?.price, { amount: 4_200_000, currency: "VND" });
  assert.deepEqual(event.booking.total, { amount: 5_700_000, currency: "VND" });
  assert.equal(records[0]?.metadata.totalVnd, 5_700_000);
});

test("a held seat whose class has no fare is a broken invariant: it throws, nothing is stored", async () => {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  // Stored past CreateFlight, which would refuse it (BR-FLT-09).
  await flightRepository.create(
    makeFlight({
      aircraftId: FIXTURE_TWO_CLASS_AIRCRAFT_ID,
      availableSeats: 30,
      fares: { ECONOMY: FIXTURE_FARES.ECONOMY },
    }),
  );
  const bookingRepository = createInMemoryBookingRepository({ flights });
  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createCapturingAuditRecorder().auditRecorder,
    outboxRepository,
    transactionRunner: createInMemoryTransactionRunner(),
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await assert.rejects(
    () => createBooking(FLIGHT_ID, passengers("Alice"), ACTOR_A),
    /no BUSINESS fare for seat 1A \(BR-FLT-09\)/,
  );
  assert.equal(entries.length, 0);
  assert.equal(
    await bookingRepository.findById(BOOKING_ID, { kind: "admin" }),
    undefined,
  );
});

test("an invalid body is validation_failed and never reaches the repository", async () => {
  const { bookingRepository: inner, transactionRunner } = await createTestRuntime(3);
  let holds = 0;
  const bookingRepository: BookingRepository = {
    ...inner,
    async holdSeats(...args) {
      holds += 1;
      return inner.holdSeats(...args);
    },
  };
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createCapturingAuditRecorder().auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(
    FLIGHT_ID,
    { passengers: [{ name: "Alice", seat: "1A" }, { name: "Bob" }] },
    ACTOR_A,
  );

  assert.deepEqual(result, {
    outcome: "validation_failed",
    issues: [
      {
        field: "passengers",
        code: "MIXED_SEAT_SELECTION",
        message: "either every passenger names a seat or none does",
      },
    ],
  });
  assert.equal(holds, 0);
});

test("a hold returning fewer seats than passengers is a programmer error: it throws, nothing is stored", async () => {
  const { bookingRepository: inner, transactionRunner } = await createTestRuntime(3);
  let creates = 0;
  const bookingRepository: BookingRepository = {
    ...inner,
    async holdSeats() {
      return {
        outcome: "held",
        seats: [{ seat: "1A", fareClass: "ECONOMY", price: FIXTURE_FARES.ECONOMY }],
      };
    },
    async create(booking) {
      creates += 1;
      return inner.create(booking);
    },
  };
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createCapturingAuditRecorder().auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await assert.rejects(
    createBooking(FLIGHT_ID, passengers("Alice", "Bob"), ACTOR_A),
    /1 seats for 2 passengers/,
  );
  assert.equal(creates, 0);
});

test("the seat is held for the booking's own id, before the booking is stored", async () => {
  const { bookingRepository: inner, transactionRunner } = await createTestRuntime();
  const calls: string[] = [];
  const bookingRepository: BookingRepository = {
    ...inner,
    async holdSeats(flightId, bookingId, request, now) {
      calls.push(`holdSeats:${bookingId}`);
      return inner.holdSeats(flightId, bookingId, request, now);
    },
    async create(booking) {
      calls.push(`create:${booking.id}`);
      return inner.create(booking);
    },
  };

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createCapturingAuditRecorder().auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await createBooking(FLIGHT_ID, passengers("Alice"), ACTOR_A);

  assert.deepEqual(calls, [`holdSeats:${BOOKING_ID}`, `create:${BOOKING_ID}`]);
});

test("booking outbox correlationId falls back to eventId when requestId is missing", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime();
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(FLIGHT_ID, passengers("Alice"), ACTOR_A);
  assert.equal(result.outcome, "created");
  assert.equal(
    (entries[0]?.payload as { correlationId: string }).correlationId,
    "fixed-outbox-id",
  );
});

test("returns not-enough-seats without outbox when no seats remain", async () => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const first = await createBooking(FLIGHT_ID, passengers("Alice"), ACTOR_A);
  const second = await createBooking(FLIGHT_ID, passengers("Bob"), ACTOR_A);

  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "not-enough-seats");
  assert.equal(entries.length, 1);
  assert.equal(records.length, 1);
  assert.equal(
    (await flightRepository.findById(FLIGHT_ID))?.availableSeats,
    0,
  );
});

test("a flight not open for sale is sales-closed: no seat taken, no audit, no event (BR-FLT-06)", async () => {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  await flightRepository.create(makeFlight({ status: "SCHEDULED", availableSeats: 3 }));
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository: createInMemoryBookingRepository({ flights }),
    auditRecorder,
    outboxRepository,
    transactionRunner: createInMemoryTransactionRunner(),
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(FLIGHT_ID, passengers("Alice"), ACTOR_A);

  assert.deepEqual(result, { outcome: "sales-closed" });
  assert.equal((await flightRepository.findById(FLIGHT_ID))?.availableSeats, 3);
  assert.equal(records.length, 0);
  assert.equal(entries.length, 0);
});

test("returns flight-not-found without outbox for missing flight", async () => {
  const { bookingRepository, transactionRunner } =
    await createTestRuntime();
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking(
    "c0ffee00-0000-4000-8000-000000000000",
    passengers("Alice"),
    ACTOR_A,
  );

  assert.equal(result.outcome, "flight-not-found");
  assert.equal(entries.length, 0);
  assert.equal(records.length, 0);
});

test("a taken reference is drawn again: the booking gets the next one and keeps the seat it already holds", async () => {
  const { bookingRepository, transactionRunner, flightRepository } =
    await createTestRuntime(2);
  const draws = ["AAAAAA", "AAAAAA", "BBBBBB"];
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder: createCapturingAuditRecorder().auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateReference: () => draws.shift() ?? "ZZZZZZ",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const first = await createBooking(FLIGHT_ID, passengers("Alice"), ACTOR_A);
  const second = await createBooking(FLIGHT_ID, passengers("Bob"), ACTOR_A);

  assert.ok(first.outcome === "created" && second.outcome === "created");
  assert.equal(first.booking.reference, "AAAAAA");
  assert.equal(second.booking.reference, "BBBBBB");
  assert.deepEqual(second.booking.passengers, [
    { name: "Bob", seat: "1B", fareClass: "ECONOMY", price: FIXTURE_FARES.ECONOMY },
  ]);
  assert.equal(draws.length, 0);
  assert.equal((await flightRepository.findById(FLIGHT_ID))?.availableSeats, 0);
});

test(`after ${MAX_REFERENCE_ATTEMPTS} taken references the use case throws, with no audit and no event`, async () => {
  const { bookingRepository: inner, transactionRunner } = await createTestRuntime();
  let attempts = 0;
  const bookingRepository: BookingRepository = {
    ...inner,
    async create() {
      attempts += 1;
      return { outcome: "reference-taken" };
    },
  };
  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  await assert.rejects(
    createBooking(FLIGHT_ID, passengers("Alice"), ACTOR_A),
    BookingReferenceExhaustedError,
  );
  assert.equal(attempts, MAX_REFERENCE_ATTEMPTS);
  assert.equal(records.length, 0);
  assert.equal(entries.length, 0);
});

test("a malformed flight id is flight-not-found, never sent to the repository", async () => {
  const { transactionRunner } = await createTestRuntime();
  const { auditRecorder } = createCapturingAuditRecorder();
  const { outboxRepository } = createCapturingOutboxRepository();
  let repositoryCalls = 0;
  const bookingRepository: BookingRepository = {
    async holdSeats() {
      repositoryCalls += 1;
      return {
        outcome: "held",
        seats: [{ seat: "1A", fareClass: "ECONOMY", price: FIXTURE_FARES.ECONOMY }],
      };
    },
    async create() {
      repositoryCalls += 1;
      return { outcome: "created" };
    },
    async findById() {
      repositoryCalls += 1;
      return undefined;
    },
    async findByReference() {
      repositoryCalls += 1;
      return undefined;
    },
    async findPage() {
      repositoryCalls += 1;
      return { items: [], totalItems: 0 };
    },
    async cancel() {
      repositoryCalls += 1;
      return { outcome: "not-found" };
    },
    async expireDueHolds() {
      repositoryCalls += 1;
      return [];
    },
    async confirmHold() {
      repositoryCalls += 1;
      return { outcome: "not-payable" };
    },
  };

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => BOOKING_ID,
    generateReference: () => REFERENCE,
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createBooking("not-a-uuid", passengers("Alice"), ACTOR_A);

  assert.deepEqual(result, { outcome: "flight-not-found" });
  assert.equal(repositoryCalls, 0);
});

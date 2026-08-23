import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import type { FlightRepository } from "../src/flights/flight-repository.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import {
  createConsoleLogger,
  type Logger,
} from "../src/observability/logger.js";
import type { TransactionRunner } from "../src/transactions/transaction-runner.js";
import type { Flight } from "../src/types.js";

const FIXED_TIME = new Date("2026-07-20T00:00:00.000Z");

function createPassthroughTransactionRunner(): TransactionRunner {
  return {
    run(operation) {
      return operation();
    },
  };
}

function makeValidRawInput(overrides: Record<string, unknown> = {}) {
  return {
    flightNumber: "vn123",
    origin: " sgn ",
    destination: "han",
    departureAt: "2026-08-10T08:00:00+07:00",
    arrivalAt: "2026-08-10T10:00:00+07:00",
    priceInCents: 15_000_000,
    currency: "vnd",
    availableSeats: 120,
    ...overrides,
  };
}

function createCapturingAuditRecorder() {
  const records: AuditRecordInput[] = [];

  const auditRecorder: AuditRecorder = {
    record(input) {
      records.push(input);
    },
  };

  return {
    auditRecorder,
    records,
  };
}

function createCapturingOutboxRepository() {
  const entries: OutboxEntry[] = [];

  const outboxRepository: OutboxRepository = {
    enqueue(entry) {
      entries.push(entry);
    },
    findUnpublished() {
      return [];
    },
    markPublished() {},
  };

  return { outboxRepository, entries };
}

function createUseCase(
  repository: FlightRepository,
  auditRecorder: AuditRecorder = createCapturingAuditRecorder().auditRecorder,
  outboxRepository: OutboxRepository = createCapturingOutboxRepository()
    .outboxRepository,
) {
  return createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    outboxRepository,
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });
}

test("valid input creates a normalized flight via repository", async () => {
  const createdFlights: Flight[] = [];
  let generateIdCalls = 0;

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create(flight) {
      createdFlights.push(flight);
      return { outcome: "created" };
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder: createCapturingAuditRecorder().auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => {
      generateIdCalls += 1;
      return "flight-fixed-id";
    },
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight(makeValidRawInput());

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") {
    return;
  }

  assert.equal(result.flight.id, "flight-fixed-id");
  assert.equal(result.flight.flightNumber, "VN123");
  assert.equal(result.flight.origin, "SGN");
  assert.equal(result.flight.destination, "HAN");
  assert.equal(result.flight.currency, "VND");
  assert.equal(result.flight.departureAt, "2026-08-10T01:00:00.000Z");
  assert.equal(result.flight.arrivalAt, "2026-08-10T03:00:00.000Z");
  assert.equal(generateIdCalls, 1);
  assert.equal(createdFlights.length, 1);
  assert.deepEqual(createdFlights[0], result.flight);
});

test("invalid input does not generate ID or call repository", async () => {
  let createCalls = 0;
  let generateIdCalls = 0;

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      createCalls += 1;
      return { outcome: "created" };
    },
  };

  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    outboxRepository,
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => {
      generateIdCalls += 1;
      return "should-not-be-used";
    },
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight({});

  assert.equal(result.outcome, "validation_failed");
  if (result.outcome !== "validation_failed") {
    return;
  }

  assert.ok(result.issues.length > 0);
  assert.equal(createCalls, 0);
  assert.equal(generateIdCalls, 0);
  assert.deepEqual(records, []);
  assert.deepEqual(entries, []);
});

test("repository duplicate becomes application duplicate", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "duplicate" };
    },
  };

  const { auditRecorder, records } = createCapturingAuditRecorder();
  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const createFlight = createUseCase(repository, auditRecorder, outboxRepository);

  const result = await createFlight(makeValidRawInput());
  assert.equal(result.outcome, "duplicate");
  assert.deepEqual(records, []);
  assert.deepEqual(entries, []);
});

test("ID generator value is passed to repository", async () => {
  let persistedId: string | undefined;

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create(flight) {
      persistedId = flight.id;
      return { outcome: "created" };
    },
  };

  const createFlight = createUseCase(repository);

  await createFlight(makeValidRawInput());
  assert.equal(persistedId, "fixed-flight-id");
});

test("unexpected repository failure is not swallowed", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      throw new Error("database failure");
    },
  };

  const createFlight = createUseCase(repository);

  await assert.rejects(
    () => createFlight(makeValidRawInput()),
    (error: unknown) =>
      error instanceof Error && error.message === "database failure",
  );
});

test("records audit log when flight is created", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const { auditRecorder, records } = createCapturingAuditRecorder();

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight(makeValidRawInput());

  assert.equal(result.outcome, "created");

  assert.deepEqual(records, [
    {
      id: "fixed-audit-id",
      action: "FLIGHT_CREATED",
      actor: {
        type: "admin_api_key",
        id: "admin",
      },
      target: {
        type: "flight",
        id: "fixed-flight-id",
      },
      requestId: "fixed-request-id",
      occurredAt: "2026-07-20T00:00:00.000Z",
      metadata: {
        flightNumber: "VN123",
        origin: "SGN",
        destination: "HAN",
      },
    },
  ]);
});

test("does not record audit when validation fails", async () => {
  let repositoryCreateCalls = 0;

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      repositoryCreateCalls += 1;
      return { outcome: "created" };
    },
  };

  const { auditRecorder, records } = createCapturingAuditRecorder();

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight({});

  assert.equal(result.outcome, "validation_failed");
  assert.equal(repositoryCreateCalls, 0);
  assert.deepEqual(records, []);
});

test("does not record audit when flight is duplicate", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "duplicate" };
    },
  };

  const { auditRecorder, records } = createCapturingAuditRecorder();

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight(makeValidRawInput());

  assert.equal(result.outcome, "duplicate");
  assert.deepEqual(records, []);
});

test("propagates audit recorder failures", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const failingAuditRecorder: AuditRecorder = {
    record() {
      throw new Error("audit database failure");
    },
  };

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder: failingAuditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner: createPassthroughTransactionRunner(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  await assert.rejects(
    () => createFlight(makeValidRawInput()),
    /audit database failure/,
  );
});

test("does not open transaction when validation fails", async () => {
  let transactionCalls = 0;

  const transactionRunner: TransactionRunner = {
    run(operation) {
      transactionCalls += 1;
      return operation();
    },
  };

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const { auditRecorder } = createCapturingAuditRecorder();

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner,
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight({});

  assert.equal(result.outcome, "validation_failed");
  assert.equal(transactionCalls, 0);
});

test("runs successful create inside a transaction", async () => {
  let transactionCalls = 0;

  const transactionRunner: TransactionRunner = {
    run(operation) {
      transactionCalls += 1;
      return operation();
    },
  };

  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const { auditRecorder } = createCapturingAuditRecorder();

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    outboxRepository: createCapturingOutboxRepository().outboxRepository,
    transactionRunner,
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    generateOutboxId: () => "fixed-outbox-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight(makeValidRawInput());

  assert.equal(result.outcome, "created");
  assert.equal(transactionCalls, 1);
});

test("enqueues flight-created outbox row after successful create", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const createFlight = createUseCase(
    repository,
    createCapturingAuditRecorder().auditRecorder,
    outboxRepository,
  );

  const result = await createFlight(makeValidRawInput());
  assert.equal(result.outcome, "created");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "fixed-outbox-id");
  assert.equal(entries[0]?.eventType, "flight-created");
  assert.equal(entries[0]?.createdAt, "2026-07-20T00:00:00.000Z");
  assert.deepEqual(entries[0]?.payload, {
    eventId: "fixed-outbox-id",
    type: "flight.created",
    occurredAt: "2026-07-20T00:00:00.000Z",
    flight: {
      id: "fixed-flight-id",
      flightNumber: "VN123",
      origin: "SGN",
      destination: "HAN",
      departureAt: "2026-08-10T01:00:00.000Z",
      arrivalAt: "2026-08-10T03:00:00.000Z",
      priceInCents: 15_000_000,
      currency: "VND",
      availableSeats: 120,
    },
  });
});

test("does not enqueue outbox row when create is duplicate", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "duplicate" };
    },
  };

  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const createFlight = createUseCase(
    repository,
    createCapturingAuditRecorder().auditRecorder,
    outboxRepository,
  );

  const result = await createFlight(makeValidRawInput());
  assert.equal(result.outcome, "duplicate");
  assert.equal(entries.length, 0);
});

test("does not enqueue outbox row when validation fails", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const { outboxRepository, entries } = createCapturingOutboxRepository();
  const createFlight = createUseCase(
    repository,
    createCapturingAuditRecorder().auditRecorder,
    outboxRepository,
  );

  const result = await createFlight({});
  assert.equal(result.outcome, "validation_failed");
  assert.equal(entries.length, 0);
});

test("outbox enqueue failure rolls back with the transaction", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const failingOutboxRepository: OutboxRepository = {
    enqueue() {
      throw new Error("outbox write failed");
    },
    findUnpublished() {
      return [];
    },
    markPublished() {},
  };

  const createFlight = createUseCase(
    repository,
    createCapturingAuditRecorder().auditRecorder,
    failingOutboxRepository,
  );

  await assert.rejects(
    () => createFlight(makeValidRawInput()),
    /outbox write failed/,
  );
});

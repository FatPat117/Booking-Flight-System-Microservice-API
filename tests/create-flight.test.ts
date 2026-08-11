import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuditRecordInput,
  AuditRecorder,
} from "../src/audit/audit-recorder.js";
import { createCreateFlight } from "../src/flights/create-flight.js";
import type { FlightRepository } from "../src/flights/flight-repository.js";
import type { MessagePublisher } from "../src/messaging/message-publisher.js";
import { createNoopMessagePublisher } from "../src/messaging/noop-message-publisher.js";
import {
  createConsoleLogger,
  type Logger,
  type LogFields,
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

function createCapturingPublisher() {
  const published: Array<{ destination: string; message: unknown }> = [];

  const messagePublisher: MessagePublisher = {
    async publish(destination, message) {
      published.push({ destination, message });
    },
    async close() {},
  };

  return { messagePublisher, published };
}

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

function createUseCase(
  repository: FlightRepository,
  auditRecorder: AuditRecorder = createCapturingAuditRecorder().auditRecorder,
  messagePublisher: MessagePublisher = createNoopMessagePublisher(),
  logger: Logger = createConsoleLogger(),
) {
  return createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher,
    logger,
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
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
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => {
      generateIdCalls += 1;
      return "flight-fixed-id";
    },
    generateAuditId: () => "fixed-audit-id",
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

  const createFlight = createCreateFlight({
    flightRepository: repository,
    auditRecorder,
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => {
      generateIdCalls += 1;
      return "should-not-be-used";
    },
    generateAuditId: () => "fixed-audit-id",
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
  const createFlight = createUseCase(repository, auditRecorder);

  const result = await createFlight(makeValidRawInput());
  assert.equal(result.outcome, "duplicate");
  assert.deepEqual(records, []);
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
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
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
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
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
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
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
    transactionRunner: createPassthroughTransactionRunner(),
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
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
    transactionRunner,
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
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
    transactionRunner,
    messagePublisher: createNoopMessagePublisher(),
    logger: createConsoleLogger(),
    generateId: () => "fixed-flight-id",
    generateAuditId: () => "fixed-audit-id",
    getRequestId: () => "fixed-request-id",
    getCurrentTime: () => FIXED_TIME,
  });

  const result = await createFlight(makeValidRawInput());

  assert.equal(result.outcome, "created");
  assert.equal(transactionCalls, 1);
});

test("publishes flight-created after successful create", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const { messagePublisher, published } = createCapturingPublisher();
  const createFlight = createUseCase(
    repository,
    createCapturingAuditRecorder().auditRecorder,
    messagePublisher,
  );

  const result = await createFlight(makeValidRawInput());
  assert.equal(result.outcome, "created");
  assert.equal(published.length, 1);
  assert.equal(published[0]?.destination, "flight-created");
  assert.deepEqual(published[0]?.message, {
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

test("does not publish when create is duplicate", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "duplicate" };
    },
  };

  const { messagePublisher, published } = createCapturingPublisher();
  const createFlight = createUseCase(
    repository,
    createCapturingAuditRecorder().auditRecorder,
    messagePublisher,
  );

  const result = await createFlight(makeValidRawInput());
  assert.equal(result.outcome, "duplicate");
  assert.equal(published.length, 0);
});

test("publish failure is logged and does not fail create", async () => {
  const repository: FlightRepository = {
    findPage: () => ({ items: [], totalItems: 0 }),
    findById: () => undefined,
    create() {
      return { outcome: "created" };
    },
  };

  const { logger, entries } = createMemoryLogger();
  const failingPublisher: MessagePublisher = {
    async publish() {
      throw new Error("broker down");
    },
    async close() {},
  };

  const createFlight = createUseCase(
    repository,
    createCapturingAuditRecorder().auditRecorder,
    failingPublisher,
    logger,
  );

  const result = await createFlight(makeValidRawInput());
  assert.equal(result.outcome, "created");
  assert.ok(
    entries.some(
      (entry) =>
        entry.level === "error" &&
        entry.message === "flight_created_publish_failed" &&
        entry.fields?.flightId === "fixed-flight-id",
    ),
  );
});

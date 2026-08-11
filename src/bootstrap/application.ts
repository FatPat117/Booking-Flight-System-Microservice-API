import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSqliteAuditRecorder } from "../audit/sqlite-audit-recorder.js";
import type { AppConfig } from "../config.js";
import { openDatabase } from "../database.js";
import {
  createCreateFlight,
  FLIGHT_CREATED_QUEUE,
  type CreateFlight,
} from "../flights/create-flight.js";
import type { FlightRepository } from "../flights/flight-repository.js";
import {
  createListFlights,
  type ListFlights,
} from "../flights/list-flights.js";
import { createSqliteFlightRepository } from "../flights/sqlite-flight-repository.js";
import {
  createHealthChecks,
  type HealthChecks,
} from "../health/health-checks.js";
import { createFlightsSummaryJob } from "../jobs/flights-summary-job.js";
import { createInMemoryJobScheduler } from "../jobs/in-memory-job-scheduler.js";
import {
  connectConsumerWithRetry,
  connectPublisherWithRetry,
} from "../messaging/connect-with-retry.js";
import { createFlightCreatedConsumer } from "../messaging/flight-created-consumer.js";
import type { MessageConsumer } from "../messaging/message-consumer.js";
import type { MessagePublisher } from "../messaging/message-publisher.js";
import {
  createConsoleLogger,
  type Logger,
} from "../observability/logger.js";
import { getRequestContext } from "../observability/request-context.js";
import { createSqliteTransactionRunner } from "../transactions/sqlite-transaction-runner.js";

const DEFAULT_FLIGHTS_SUMMARY_INTERVAL_MS = 60_000;

/**
 * Fully wired application graph.
 * Built once at the Composition Root; HTTP and future workers consume this object.
 * SQLite + JobScheduler + MessagePublisher stay private — consumers use close().
 */
export type Application = Readonly<{
  config: AppConfig;
  logger: Logger;
  flightRepository: FlightRepository;
  createFlight: CreateFlight;
  listFlights: ListFlights;
  healthChecks: HealthChecks;
  close(): Promise<void>;
}>;

export type CreateApplicationOptions = {
  config: AppConfig;
  logger?: Logger;
  /** Override for tests; production default is 60s */
  flightsSummaryIntervalMs?: number;
  /**
   * Tests inject noops so the suite does not need RabbitMQ.
   * Production omits these and connects via config.rabbitmqUrl.
   */
  messagePublisher?: MessagePublisher;
  messageConsumer?: MessageConsumer;
};

/**
 * Composition Root: the only place that constructs and wires infrastructure + use cases.
 */
export async function createApplication(
  options: CreateApplicationOptions,
): Promise<Application> {
  const { config } = options;
  const logger = options.logger ?? createConsoleLogger();
  const flightsSummaryIntervalMs =
    options.flightsSummaryIntervalMs ?? DEFAULT_FLIGHTS_SUMMARY_INTERVAL_MS;

  const databasePath = resolveDatabasePath(config.databasePath);
  ensureDatabaseDirectory(databasePath);

  const database = openDatabase(databasePath);
  const flightRepository = createSqliteFlightRepository(database);
  const auditRecorder = createSqliteAuditRecorder(database);
  const transactionRunner = createSqliteTransactionRunner(database);
  const healthChecks = createHealthChecks(database);

  // Separate AMQP connections: publisher and consumer fail independently.
  const messagePublisher =
    options.messagePublisher ??
    (await connectPublisherWithRetry({
      connectionUrl: config.rabbitmqUrl,
      logger,
    }));

  const messageConsumer =
    options.messageConsumer ??
    (await connectConsumerWithRetry({
      connectionUrl: config.rabbitmqUrl,
      logger,
    }));

  await messageConsumer.subscribe(
    FLIGHT_CREATED_QUEUE,
    createFlightCreatedConsumer({ logger }),
  );

  const createFlight = createCreateFlight({
    flightRepository,
    auditRecorder,
    transactionRunner,
    messagePublisher,
    logger,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });

  const listFlights = createListFlights({
    flightRepository,
  });

  const jobScheduler = createInMemoryJobScheduler(logger);
  jobScheduler.register(
    createFlightsSummaryJob({
      flightRepository,
      logger,
      intervalMs: flightsSummaryIntervalMs,
    }),
  );
  jobScheduler.start();

  return {
    config,
    logger,
    flightRepository,
    createFlight,
    listFlights,
    healthChecks,
    async close() {
      // Jobs use DB; AMQP clients are independent of each other and of SQLite.
      jobScheduler.stop();
      await messagePublisher.close();
      await messageConsumer.close();
      database.close();
    },
  };
}

function resolveDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:") {
    return ":memory:";
  }

  return resolve(databasePath);
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  mkdirSync(dirname(databasePath), { recursive: true });
}

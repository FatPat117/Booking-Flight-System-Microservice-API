import { createPostgresAuditRecorder } from "../audit/postgres/postgres-audit-recorder.js";
import type { AppConfig } from "../config.js";
import {
  createCancelBooking,
  type CancelBooking,
} from "../bookings/cancel-booking.js";
import {
  createCreateBooking,
  type CreateBooking,
} from "../bookings/create-booking.js";
import {
  createGetBooking,
  type GetBooking,
} from "../bookings/get-booking.js";
import {
  createListBookings,
  type ListBookings,
} from "../bookings/list-bookings.js";
import { createPostgresBookingRepository } from "../bookings/postgres/postgres-booking-repository.js";
import type { BookingRepository } from "../bookings/booking-repository.js";
import {
  createCreateFlight,
  type CreateFlight,
} from "../flights/create-flight.js";
import type { FlightRepository } from "../flights/flight-repository.js";
import {
  createListFlights,
  type ListFlights,
} from "../flights/list-flights.js";
import { createPostgresFlightRepository } from "../flights/postgres/postgres-flight-repository.js";
import type { HealthChecks } from "../health/health-checks.js";
import { createPostgresHealthChecks } from "../health/postgres/postgres-health-checks.js";
import { createFlightsSummaryJob } from "../jobs/flights-summary-job.js";
import { createInMemoryJobScheduler } from "../jobs/in-memory-job-scheduler.js";
import { connectPublisherWithRetry } from "../messaging/connect-with-retry.js";
import type { MessagePublisher } from "../messaging/message-publisher.js";
import { createOutboxRelayJob } from "../outbox/outbox-relay-job.js";
import { createPostgresOutboxRepository } from "../outbox/postgres/postgres-outbox-repository.js";
import {
  createConsoleLogger,
  type Logger,
} from "../observability/logger.js";
import { getRequestContext } from "../observability/request-context.js";
import { createBookingDataSource } from "../postgres/data-source.js";
import { createPostgresTransactionRunner } from "../transactions/postgres-transaction-runner.js";

const DEFAULT_FLIGHTS_SUMMARY_INTERVAL_MS = 60_000;
const DEFAULT_OUTBOX_RELAY_INTERVAL_MS = 5_000;

/**
 * Fully wired application graph.
 * Built once at the Composition Root; HTTP consumes this object.
 * DataSource + JobScheduler + MessagePublisher stay private — consumers use close().
 * Message consumption lives in services/flight-notifier (Day 22).
 */
export type Application = Readonly<{
  config: AppConfig;
  logger: Logger;
  flightRepository: FlightRepository;
  bookingRepository: BookingRepository;
  createFlight: CreateFlight;
  createBooking: CreateBooking;
  cancelBooking: CancelBooking;
  getBooking: GetBooking;
  listBookings: ListBookings;
  listFlights: ListFlights;
  healthChecks: HealthChecks;
  close(): Promise<void>;
}>;

export type CreateApplicationOptions = {
  config: AppConfig;
  logger?: Logger;
  /** Override for tests; production default is 60s */
  flightsSummaryIntervalMs?: number;
  /** Override for tests; production default is 5s */
  outboxRelayIntervalMs?: number;
  /**
   * Tests inject a noop publisher so the suite does not need RabbitMQ.
   * Production omits this and connects via config.rabbitmqUrl.
   */
  messagePublisher?: MessagePublisher;
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
  const outboxRelayIntervalMs =
    options.outboxRelayIntervalMs ?? DEFAULT_OUTBOX_RELAY_INTERVAL_MS;

  const dataSource = createBookingDataSource(config.postgres);
  await dataSource.initialize();
  // Single api instance today (Day 17 limitation) — running migrations at
  // startup is safe here and keeps the migrate-on-boot behavior the app has
  // had since Day 15. Multiple instances starting
  // concurrently would need this run as a separate step instead.
  await dataSource.runMigrations();

  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const auditRecorder = createPostgresAuditRecorder(dataSource);
  const outboxRepository = createPostgresOutboxRepository(dataSource);
  const transactionRunner = createPostgresTransactionRunner(dataSource);
  const healthChecks = createPostgresHealthChecks(dataSource);

  const messagePublisher =
    options.messagePublisher ??
    (await connectPublisherWithRetry({
      connectionUrl: config.rabbitmqUrl,
      logger,
    }));

  const createFlight = createCreateFlight({
    flightRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });

  const cancelBooking = createCancelBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });

  const getBooking = createGetBooking({ bookingRepository });
  const listBookings = createListBookings({ bookingRepository });

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
  jobScheduler.register(
    createOutboxRelayJob({
      outboxRepository,
      messagePublisher,
      logger,
      intervalMs: outboxRelayIntervalMs,
    }),
  );
  jobScheduler.start();

  return {
    config,
    logger,
    flightRepository,
    bookingRepository,
    createFlight,
    createBooking,
    cancelBooking,
    getBooking,
    listBookings,
    listFlights,
    healthChecks,
    async close() {
      // Same order as before (Day 17): stop the job before closing what it
      // depends on. dataSource.destroy() replaces database.close().
      jobScheduler.stop();
      await messagePublisher.close();
      await dataSource.destroy();
    },
  };
}

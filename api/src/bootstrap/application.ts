import { createPostgresAircraftRepository } from "../aircraft/postgres/postgres-aircraft-repository.js";
import {
  createRegisterAircraft,
  type RegisterAircraft,
} from "../aircraft/register-aircraft.js";
import {
  createListAirports,
  type ListAirports,
} from "../airports/list-airports.js";
import { createPostgresAirportRepository } from "../airports/postgres/postgres-airport-repository.js";
import {
  createRegisterAirport,
  type RegisterAirport,
} from "../airports/register-airport.js";
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
import { createExpireHolds } from "../bookings/expire-holds.js";
import {
  createGetBooking,
  type GetBooking,
} from "../bookings/get-booking.js";
import {
  createGetBookingByReference,
  type GetBookingByReference,
} from "../bookings/get-booking-by-reference.js";
import {
  createListBookings,
  type ListBookings,
} from "../bookings/list-bookings.js";
import { createPostgresBookingRepository } from "../bookings/postgres/postgres-booking-repository.js";
import type { BookingRepository } from "../bookings/booking-repository.js";
import { generateBookingReference } from "../bookings/booking-reference.js";
import {
  createCreateFlight,
  type CreateFlight,
} from "../flights/create-flight.js";
import type { FlightRepository } from "../flights/flight-repository.js";
import { createGetFlight, type GetFlight } from "../flights/get-flight.js";
import {
  createGetFlightSeatMap,
  type GetFlightSeatMap,
} from "../flights/get-flight-seat-map.js";
import {
  createListFlights,
  type ListFlights,
} from "../flights/list-flights.js";
import { createOpenFlight, type OpenFlight } from "../flights/open-flight.js";
import { createPostgresFlightRepository } from "../flights/postgres/postgres-flight-repository.js";
import type { HealthChecks } from "../health/health-checks.js";
import { createPostgresHealthChecks } from "../health/postgres/postgres-health-checks.js";
import { createBookingHoldExpiryJob } from "../jobs/booking-hold-expiry-job.js";
import { createPaymentReconciliationJob } from "../jobs/payment-reconciliation-job.js";
import { createIdempotencyKeyCleanupJob } from "../jobs/idempotency-key-cleanup-job.js";
import { createFlightsSummaryJob } from "../jobs/flights-summary-job.js";
import { createInMemoryJobScheduler } from "../jobs/in-memory-job-scheduler.js";
import { connectPublisherWithRetry } from "../messaging/connect-with-retry.js";
import type { MessagePublisher } from "../messaging/message-publisher.js";
import { createOutboxRelayJob } from "../outbox/outbox-relay-job.js";
import { createPostgresOutboxRepository } from "../outbox/postgres/postgres-outbox-repository.js";
import { createCleanupIdempotencyKeys } from "../idempotency/cleanup-idempotency-keys.js";
import { createPostgresIdempotencyRepository } from "../idempotency/postgres/postgres-idempotency-repository.js";
import {
  createPayForBooking,
  PAYMENT_RECONCILIATION_MARGIN_MS,
  type PayForBooking,
} from "../payments/pay-for-booking.js";
import { createPostgresPaymentRepository } from "../payments/postgres/postgres-payment-repository.js";
import { createReconcilePayments } from "../payments/reconcile-payments.js";
import { createSimulatedPaymentGateway } from "../payments/simulated-payment-gateway.js";
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
 * Decision 12: a seat is freed at most ~60 s after its hold lapses; one run
 * expires at most 50 × 20 = 1 000 bookings, in transactions of 50.
 */
const DEFAULT_HOLD_EXPIRY_INTERVAL_MS = 60_000;
const HOLD_EXPIRY_BATCH_SIZE = 50;
const HOLD_EXPIRY_MAX_BATCHES = 20;
/**
 * Decision 15: a due payment waits at most ~30 s for the job. A batch's
 * gateway calls run concurrently, so one run takes about one gateway timeout
 * per batch; 20 × 5 = 100 payments per run.
 */
const DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS = 30_000;
const PAYMENT_RECONCILIATION_BATCH_SIZE = 20;
const PAYMENT_RECONCILIATION_MAX_BATCHES = 5;
/** BR-PAY-10: hourly is enough for a 24 h retention; 500 × 20 = 10 000 keys per run. */
const DEFAULT_IDEMPOTENCY_KEY_CLEANUP_INTERVAL_MS = 60 * 60_000;
const IDEMPOTENCY_KEY_CLEANUP_BATCH_SIZE = 500;
const IDEMPOTENCY_KEY_CLEANUP_MAX_BATCHES = 20;

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
  openFlight: OpenFlight;
  createBooking: CreateBooking;
  cancelBooking: CancelBooking;
  payForBooking: PayForBooking;
  getBooking: GetBooking;
  getBookingByReference: GetBookingByReference;
  listBookings: ListBookings;
  getFlight: GetFlight;
  getFlightSeatMap: GetFlightSeatMap;
  listFlights: ListFlights;
  registerAirport: RegisterAirport;
  listAirports: ListAirports;
  registerAircraft: RegisterAircraft;
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
  /** Override for tests; production default is 60s */
  holdExpiryIntervalMs?: number;
  /** Override for tests; production default is 30s */
  paymentReconciliationIntervalMs?: number;
  /** Override for tests; production default is 1h */
  idempotencyKeyCleanupIntervalMs?: number;
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
  const holdExpiryIntervalMs =
    options.holdExpiryIntervalMs ?? DEFAULT_HOLD_EXPIRY_INTERVAL_MS;
  const paymentReconciliationIntervalMs =
    options.paymentReconciliationIntervalMs ?? DEFAULT_PAYMENT_RECONCILIATION_INTERVAL_MS;
  const idempotencyKeyCleanupIntervalMs =
    options.idempotencyKeyCleanupIntervalMs ?? DEFAULT_IDEMPOTENCY_KEY_CLEANUP_INTERVAL_MS;
  /** How long after phase 1 a PROCESSING payment is reconciliation's; also the job's lease. */
  const reconcileAfterMs = config.paymentGatewayTimeoutMs + PAYMENT_RECONCILIATION_MARGIN_MS;

  const dataSource = createBookingDataSource(config.postgres);
  await dataSource.initialize();
  // Single api instance today (Day 17 limitation) — running migrations at
  // startup is safe here and keeps the migrate-on-boot behavior the app has
  // had since Day 15. Multiple instances starting
  // concurrently would need this run as a separate step instead.
  await dataSource.runMigrations();

  const flightRepository = createPostgresFlightRepository(dataSource);
  const bookingRepository = createPostgresBookingRepository(dataSource);
  const airportRepository = createPostgresAirportRepository(dataSource);
  const aircraftRepository = createPostgresAircraftRepository(dataSource);
  const auditRecorder = createPostgresAuditRecorder(dataSource);
  const outboxRepository = createPostgresOutboxRepository(dataSource);
  const paymentRepository = createPostgresPaymentRepository(dataSource);
  const idempotencyRepository = createPostgresIdempotencyRepository(dataSource);
  const paymentGateway = createSimulatedPaymentGateway({
    delayMs: config.paymentSimulatorDelayMs,
    timeoutMs: config.paymentGatewayTimeoutMs,
  });
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
    airportRepository,
    aircraftRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });

  const openFlight = createOpenFlight({
    flightRepository,
    auditRecorder,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });

  const createBooking = createCreateBooking({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateReference: () => generateBookingReference(),
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

  const payForBooking = createPayForBooking({
    bookingRepository,
    paymentRepository,
    idempotencyRepository,
    paymentGateway,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    logger,
    generatePaymentId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
    reconcileAfterMs,
  });

  const reconcilePayments = createReconcilePayments({
    bookingRepository,
    paymentRepository,
    idempotencyRepository,
    paymentGateway,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    logger,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getRequestId: () => undefined,
    getCurrentTime: () => new Date(),
    leaseMs: reconcileAfterMs,
    batchSize: PAYMENT_RECONCILIATION_BATCH_SIZE,
    maxBatches: PAYMENT_RECONCILIATION_MAX_BATCHES,
  });

  const cleanupIdempotencyKeys = createCleanupIdempotencyKeys({
    idempotencyRepository,
    transactionRunner,
    getCurrentTime: () => new Date(),
    batchSize: IDEMPOTENCY_KEY_CLEANUP_BATCH_SIZE,
    maxBatches: IDEMPOTENCY_KEY_CLEANUP_MAX_BATCHES,
  });

  const expireHolds = createExpireHolds({
    bookingRepository,
    auditRecorder,
    outboxRepository,
    transactionRunner,
    generateAuditId: () => crypto.randomUUID(),
    generateOutboxId: () => crypto.randomUUID(),
    getCurrentTime: () => new Date(),
    batchSize: HOLD_EXPIRY_BATCH_SIZE,
    maxBatches: HOLD_EXPIRY_MAX_BATCHES,
  });

  const getBooking = createGetBooking({
    bookingRepository,
    getCurrentTime: () => new Date(),
  });
  const getBookingByReference = createGetBookingByReference({
    bookingRepository,
    getCurrentTime: () => new Date(),
  });
  const listBookings = createListBookings({
    bookingRepository,
    getCurrentTime: () => new Date(),
  });

  const getFlight = createGetFlight({
    flightRepository,
    getCurrentTime: () => new Date(),
  });
  const getFlightSeatMap = createGetFlightSeatMap({ flightRepository });
  const listFlights = createListFlights({
    flightRepository,
    getCurrentTime: () => new Date(),
  });

  const registerAirport = createRegisterAirport({
    airportRepository,
    auditRecorder,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });
  const listAirports = createListAirports({ airportRepository });

  const registerAircraft = createRegisterAircraft({
    aircraftRepository,
    auditRecorder,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
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
  jobScheduler.register(
    createBookingHoldExpiryJob({
      expireHolds,
      logger,
      intervalMs: holdExpiryIntervalMs,
    }),
  );
  jobScheduler.register(
    createPaymentReconciliationJob({
      reconcilePayments,
      logger,
      intervalMs: paymentReconciliationIntervalMs,
    }),
  );
  jobScheduler.register(
    createIdempotencyKeyCleanupJob({
      cleanupIdempotencyKeys,
      logger,
      intervalMs: idempotencyKeyCleanupIntervalMs,
    }),
  );
  jobScheduler.start();

  return {
    config,
    logger,
    flightRepository,
    bookingRepository,
    createFlight,
    openFlight,
    createBooking,
    cancelBooking,
    payForBooking,
    getBooking,
    getBookingByReference,
    listBookings,
    getFlight,
    getFlightSeatMap,
    listFlights,
    registerAirport,
    listAirports,
    registerAircraft,
    healthChecks,
    async close() {
      // Same order as before (Day 17): stop the job before closing what it
      // depends on. dataSource.destroy() replaces database.close(). Awaited
      // since Day 48B: a run in progress finishes its transaction first.
      await jobScheduler.stop();
      await messagePublisher.close();
      await dataSource.destroy();
    },
  };
}

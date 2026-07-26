import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createSqliteAuditRecorder } from "../audit/sqlite-audit-recorder.js";
import type { AppConfig } from "../config.js";
import { openDatabase } from "../database.js";
import {
  createCreateFlight,
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
import {
  createConsoleLogger,
  type Logger,
} from "../observability/logger.js";
import { getRequestContext } from "../observability/request-context.js";
import { createSqliteTransactionRunner } from "../transactions/sqlite-transaction-runner.js";

/**
 * Fully wired application graph.
 * Built once at the Composition Root; HTTP and future workers consume this object.
 */
export type Application = Readonly<{
  config: AppConfig;
  logger: Logger;
  database: DatabaseSync;
  flightRepository: FlightRepository;
  createFlight: CreateFlight;
  listFlights: ListFlights;
  healthChecks: HealthChecks;
  close(): void;
}>;

export type CreateApplicationOptions = {
  config: AppConfig;
  logger?: Logger;
};

/**
 * Composition Root: the only place that constructs and wires infrastructure + use cases.
 */
export function createApplication(
  options: CreateApplicationOptions,
): Application {
  const { config } = options;
  const logger = options.logger ?? createConsoleLogger();

  const databasePath = resolveDatabasePath(config.databasePath);
  ensureDatabaseDirectory(databasePath);

  const database = openDatabase(databasePath);
  const flightRepository = createSqliteFlightRepository(database);
  const auditRecorder = createSqliteAuditRecorder(database);
  const transactionRunner = createSqliteTransactionRunner(database);
  const healthChecks = createHealthChecks(database);

  const createFlight = createCreateFlight({
    flightRepository,
    auditRecorder,
    transactionRunner,
    generateId: () => crypto.randomUUID(),
    generateAuditId: () => crypto.randomUUID(),
    getRequestId: () => getRequestContext()?.requestId,
    getCurrentTime: () => new Date(),
  });

  const listFlights = createListFlights({
    flightRepository,
  });

  return {
    config,
    logger,
    database,
    flightRepository,
    createFlight,
    listFlights,
    healthChecks,
    close() {
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

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createApp } from "./app.js";
import { createSqliteAuditRecorder } from "./audit/sqlite-audit-recorder.js";
import { parseConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { createCreateFlight } from "./flights/create-flight.js";
import { createListFlights } from "./flights/list-flights.js";
import { createSqliteFlightRepository } from "./flights/sqlite-flight-repository.js";
import { createHealthChecks } from "./health/health-checks.js";
import { createConsoleLogger } from "./observability/logger.js";
import { getRequestContext } from "./observability/request-context.js";

const config = parseConfig(process.env);
const logger = createConsoleLogger();

const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });

const database = openDatabase(databasePath);
const flightRepository = createSqliteFlightRepository(database);
const auditRecorder = createSqliteAuditRecorder(database);
const healthChecks = createHealthChecks(database);

const createFlight = createCreateFlight({
  flightRepository,
  auditRecorder,
  generateId: () => crypto.randomUUID(),
  generateAuditId: () => crypto.randomUUID(),
  getRequestId: () => getRequestContext()?.requestId,
  getCurrentTime: () => new Date(),
});

const listFlights = createListFlights({
  flightRepository,
});

const app = createApp({
  flightRepository,
  createFlight,
  listFlights,
  logger,
  healthChecks,
  adminApiKey: config.adminApiKey,
});

const server = app.listen(config.port, () => {
  logger.info("server_started", {
    port: config.port,
    databasePath,
  });
});

function shutdown() {
  logger.info("server_shutdown_started");

  server.close(() => {
    database.close();
    logger.info("server_shutdown_completed");
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

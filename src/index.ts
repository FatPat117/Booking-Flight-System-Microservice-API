import { createApp } from "./app.js";
import { createApplication } from "./bootstrap/application.js";
import { parseConfig } from "./config.js";

const config = parseConfig(process.env);
const application = createApplication({ config });

const app = createApp({
  flightRepository: application.flightRepository,
  createFlight: application.createFlight,
  listFlights: application.listFlights,
  logger: application.logger,
  healthChecks: application.healthChecks,
  adminApiKey: application.config.adminApiKey,
});

const server = app.listen(application.config.port, () => {
  application.logger.info("server_started", {
    port: application.config.port,
    databasePath: application.config.databasePath,
  });
});

function shutdown() {
  application.logger.info("server_shutdown_started");

  server.close(() => {
    application.close();
    application.logger.info("server_shutdown_completed");
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

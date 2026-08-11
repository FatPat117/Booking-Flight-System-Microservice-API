import { createApp } from "./app.js";
import { createApplication } from "./bootstrap/application.js";
import { parseConfig } from "./config.js";

const config = parseConfig(process.env);
const runtime = await createApplication({ config });

const expressApp = createApp({
  flightRepository: runtime.flightRepository,
  createFlight: runtime.createFlight,
  listFlights: runtime.listFlights,
  logger: runtime.logger,
  healthChecks: runtime.healthChecks,
  adminApiKey: runtime.config.adminApiKey,
});

const httpServer = expressApp.listen(runtime.config.port, () => {
  runtime.logger.info("server_started", {
    port: runtime.config.port,
    databasePath: runtime.config.databasePath,
  });
});

function shutdown() {
  runtime.logger.info("server_shutdown_started");

  httpServer.close(() => {
    void runtime.close().then(() => {
      runtime.logger.info("server_shutdown_completed");
      process.exit(0);
    });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

import { createApp } from "./app.js";
import { createApplication } from "./bootstrap/application.js";
import { parseConfig } from "./config.js";

const config = parseConfig(process.env);
const runtime = await createApplication({ config });

const expressApp = createApp({
  getFlight: runtime.getFlight,
  createFlight: runtime.createFlight,
  createBooking: runtime.createBooking,
  cancelBooking: runtime.cancelBooking,
  getBooking: runtime.getBooking,
  listBookings: runtime.listBookings,
  listFlights: runtime.listFlights,
  registerAirport: runtime.registerAirport,
  listAirports: runtime.listAirports,
  registerAircraft: runtime.registerAircraft,
  logger: runtime.logger,
  healthChecks: runtime.healthChecks,
  jwtSecret: runtime.config.jwtSecret,
});

const httpServer = expressApp.listen(runtime.config.port, () => {
  runtime.logger.info("server_started", {
    port: runtime.config.port,
    postgresHost: runtime.config.postgres.host,
    postgresDatabase: runtime.config.postgres.database,
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

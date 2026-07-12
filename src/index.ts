import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { createCreateFlight } from "./flights/create-flight.js";
import { createSqliteFlightRepository } from "./flights/sqlite-flight-repository.js";

const config = parseConfig(process.env);

const databasePath = resolve(config.databasePath);
mkdirSync(dirname(databasePath), { recursive: true });

const database = openDatabase(databasePath);
const flightRepository = createSqliteFlightRepository(database);

const createFlight = createCreateFlight({
  flightRepository,
  generateId: () => crypto.randomUUID(),
});

const app = createApp({
  flightRepository,
  createFlight,
});

const server = app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
  console.log(`SQLite database: ${databasePath}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

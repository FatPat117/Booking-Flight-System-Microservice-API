import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

const PORT = 3000;
const databasePath = resolve("data/booking.db");

mkdirSync(dirname(databasePath), { recursive: true });

const database = openDatabase(databasePath);
const app = createApp(database);

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
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

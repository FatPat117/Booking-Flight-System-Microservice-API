import "reflect-metadata";

import { parsePostgresConfig } from "./config.js";
import { createBookingDataSource } from "./data-source.js";

const config = parsePostgresConfig(process.env);
const dataSource = createBookingDataSource(config);

await dataSource.initialize();
const executed = await dataSource.runMigrations();
console.log(
  JSON.stringify({
    message: "migrations_completed",
    count: executed.length,
    names: executed.map((migration) => migration.name),
  }),
);
await dataSource.destroy();

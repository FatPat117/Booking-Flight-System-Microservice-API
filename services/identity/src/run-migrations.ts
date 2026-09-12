import "reflect-metadata";

import { parseIdentityConfig } from "./config.js";
import { createIdentityDataSource } from "./data-source.js";

const config = parseIdentityConfig(process.env);
const dataSource = createIdentityDataSource(config.postgres);

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

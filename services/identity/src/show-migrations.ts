import "reflect-metadata";

import { MigrationExecutor } from "typeorm";

import { parseIdentityConfig } from "./config.js";
import { createIdentityDataSource } from "./data-source.js";

const config = parseIdentityConfig(process.env);
const dataSource = createIdentityDataSource(config.postgres);

await dataSource.initialize();

const queryRunner = dataSource.createQueryRunner();
const executor = new MigrationExecutor(dataSource, queryRunner);

const executed = await executor.getExecutedMigrations();
const pending = await executor.getPendingMigrations();

console.log(
  JSON.stringify(
    {
      message: "migrations_status",
      executed: executed.map((migration) => migration.name),
      pending: pending.map((migration) => migration.name),
    },
    null,
    2,
  ),
);

await queryRunner.release();
await dataSource.destroy();

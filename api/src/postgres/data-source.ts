import "reflect-metadata";

import { DataSource } from "typeorm";

import { FlightEntity } from "../flights/postgres/flight.entity.js";
import type { PostgresConfig } from "./config.js";
import { CreateFlights1790424994000 } from "./migrations/1790424994000-CreateFlights.js";

/**
 * Day 36 — dev-complete only. Entities/migrations are added per Strangler
 * Fig step (FlightEntity first); this DataSource is not constructed by
 * bootstrap/application.ts until the combined cutover
 * (docs/migration-plan-postgres.md Section 5.2).
 */
export function createBookingDataSource(config: PostgresConfig): DataSource {
  return new DataSource({
    type: "postgres",
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    // Never true outside throwaway local experiments — migrations own schema.
    synchronize: false,
    entities: [FlightEntity],
    migrations: [CreateFlights1790424994000],
  });
}

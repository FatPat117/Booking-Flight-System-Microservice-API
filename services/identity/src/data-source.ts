import "reflect-metadata";

import { DataSource } from "typeorm";

import { UserEntity } from "./entities/user.entity.js";
import { CreateUsers1726147200000 } from "./migrations/1726147200000-CreateUsers.js";

export type IdentityDatabaseConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
};

export function createIdentityDataSource(
  config: IdentityDatabaseConfig,
): DataSource {
  return new DataSource({
    type: "postgres",
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    // Never true outside throwaway local experiments — migrations own schema.
    synchronize: false,
    entities: [UserEntity],
    migrations: [CreateUsers1726147200000],
  });
}

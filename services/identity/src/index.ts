import "reflect-metadata";

import { createIdentityApp } from "./app.js";
import { parseIdentityConfig } from "./config.js";
import { createIdentityDataSource } from "./data-source.js";
import { createRegisterUser } from "./register/register.js";
import { hashPasswordWithBcrypt } from "./security/password-hasher.js";
import { createTypeOrmUserRepository } from "./users/typeorm-user-repository.js";

const config = parseIdentityConfig(process.env);
const dataSource = createIdentityDataSource(config.postgres);

await dataSource.initialize();
await dataSource.runMigrations();

const userRepository = createTypeOrmUserRepository(dataSource);
const registerUser = createRegisterUser({
  userRepository,
  hashPassword: hashPasswordWithBcrypt,
});

const app = createIdentityApp({ registerUser });

const httpServer = app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      message: "identity_server_started",
      port: config.port,
      database: config.postgres.database,
    }),
  );
});

async function shutdown() {
  httpServer.close(async () => {
    await dataSource.destroy();
    process.exit(0);
  });
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

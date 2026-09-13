import "reflect-metadata";

import { parseIdentityConfig } from "./config.js";
import { createIdentityDataSource } from "./data-source.js";
import { UserEntity } from "./entities/user.entity.js";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npm run promote-to-admin -- <email>");
    process.exit(1);
  }

  const config = parseIdentityConfig(process.env);
  const dataSource = createIdentityDataSource(config.postgres);

  await dataSource.initialize();
  const repository = dataSource.getRepository(UserEntity);

  const user = await repository.findOneBy({ email });
  if (!user) {
    console.error(`No user found with email: ${email}`);
    await dataSource.destroy();
    process.exit(1);
  }

  user.role = "admin";
  await repository.save(user);
  console.log(`User ${email} is now admin.`);

  await dataSource.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

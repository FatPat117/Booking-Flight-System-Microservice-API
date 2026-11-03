import { parseIdentityConfig } from "../../src/config.js";

/**
 * Preloaded with --import into every integration test process, so it runs
 * before any test file's before/beforeEach (Day 50, the same guard api got on
 * Day 49C). typeorm-user-repository's beforeEach TRUNCATEs users; this
 * refuses to start unless the target database is a *_test one, so a missing
 * or wrong IDENTITY_POSTGRES_DB can never wipe identity_db.
 */
const { database } = parseIdentityConfig(process.env).postgres;

if (!database.endsWith("_test")) {
  process.stderr.write(
    `Refusing to run integration tests against "${database}": ` +
      'IDENTITY_POSTGRES_DB must name a database ending in "_test" ' +
      "(npm run test:integration sets identity_test).\n",
  );
  process.exit(1);
}

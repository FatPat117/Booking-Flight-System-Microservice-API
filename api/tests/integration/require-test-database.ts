import { parsePostgresConfig } from "../../src/postgres/config.js";

/**
 * Preloaded with --import into every integration test process, so it runs
 * before any test file's before/beforeEach (Day 49C). Those hooks TRUNCATE
 * the tables they use; this refuses to start unless the target database is a
 * *_test one, so a missing or wrong BOOKING_POSTGRES_DB can never wipe
 * booking_db — which happened twice on Day 49B.
 */
const { database } = parsePostgresConfig(process.env);

if (!database.endsWith("_test")) {
  process.stderr.write(
    `Refusing to run integration tests against "${database}": ` +
      'BOOKING_POSTGRES_DB must name a database ending in "_test" ' +
      "(npm run test:integration sets booking_test).\n",
  );
  process.exit(1);
}

export type PostgresConfig = Readonly<{
  host: string;
  port: number;
  username: string;
  password: string;
  /** Fixed: booking_db is a second logical database in the same Postgres
   * container as identity_db (Day 36) — not driven by POSTGRES_DB, which
   * still names identity's database. */
  database: string;
}>;

type Environment = Record<string, string | undefined>;

const DEFAULT_POSTGRES_PORT = 5432;
const BOOKING_DATABASE_NAME = "booking_db";

/**
 * Test-convenience config for the *.integration.test.ts files: soft
 * defaults so `npm run test:integration` works with zero required env vars
 * locally. NOT used by the real Composition Root (src/config.ts's
 * parseConfig builds its own fail-fast PostgresConfig for that — see its
 * doc comment).
 *
 * Day 40: defaults changed from identity's own POSTGRES_USER/PASSWORD
 * (which, via the official postgres image's bootstrap env vars, is
 * actually the cluster SUPERUSER — it bypasses every privilege check,
 * including the identity_db CONNECT revoke docker/postgres-init adds) to
 * BOOKING_POSTGRES_USER/PASSWORD, the same dedicated, non-superuser role
 * the real app connects with. Using the superuser here would let every
 * integration test quietly pass even if the booking role's privileges were
 * wrong — these tests are the one thing that actually exercises that role.
 */
export function parsePostgresConfig(environment: Environment): PostgresConfig {
  return {
    host: environment.POSTGRES_HOST?.trim() || "localhost",
    port: parsePostgresPort(environment.POSTGRES_PORT),
    username: environment.BOOKING_POSTGRES_USER?.trim() || "booking",
    password:
      environment.BOOKING_POSTGRES_PASSWORD?.trim() || "booking_dev_password",
    database: BOOKING_DATABASE_NAME,
  };
}

function parsePostgresPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_POSTGRES_PORT;
  }

  const trimmed = raw.trim();

  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      "Invalid POSTGRES_PORT: expected an integer between 1 and 65535",
    );
  }

  const port = Number(trimmed);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "Invalid POSTGRES_PORT: expected an integer between 1 and 65535",
    );
  }

  return port;
}

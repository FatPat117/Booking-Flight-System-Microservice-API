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
 * Day 36 — dev-complete only. Not read by config.ts/parseConfig and not
 * wired into bootstrap/application.ts yet; exists so the new Postgres
 * repositories and their integration tests have a typed config source
 * ahead of the Strangler Fig cutover (docs/migration-plan-postgres.md
 * Section 5.2).
 */
export function parsePostgresConfig(environment: Environment): PostgresConfig {
  return {
    host: environment.POSTGRES_HOST?.trim() || "localhost",
    port: parsePostgresPort(environment.POSTGRES_PORT),
    username: environment.POSTGRES_USER?.trim() || "identity",
    password:
      environment.POSTGRES_PASSWORD?.trim() || "identity_dev_password",
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

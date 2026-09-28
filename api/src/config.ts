import type { PostgresConfig } from "./postgres/config.js";

export type AppConfig = Readonly<{
  port: number;
  /** Shared with identity — same value from root `.env` (Day 33). */
  jwtSecret: string;
  /** AMQP URL — host is `localhost` on the machine, `rabbitmq` inside compose */
  rabbitmqUrl: string;
  /**
   * Day 40 — the only Postgres config the Composition Root reads: unlike
   * postgres/config.ts's parsePostgresConfig() (soft defaults, for local
   * integration-test convenience only), username/password here are
   * fail-fast — no default credential is safe to bake into source, same
   * reasoning as jwtSecret. Connects with a role dedicated to booking_db
   * (BOOKING_POSTGRES_USER/PASSWORD), not identity's own POSTGRES_USER/
   * PASSWORD, so a misused api connection has no path to identity_db.
   */
  postgres: PostgresConfig;
}>;

type Environment = Record<string, string | undefined>;

const DEFAULT_PORT = 3000;
/** Local default: broker published on host port 5672 (Day 19 compose). */
const DEFAULT_RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
const DEFAULT_POSTGRES_HOST = "localhost";
const DEFAULT_POSTGRES_PORT = 5432;
/** Fixed, not env-driven — see postgres/config.ts's own BOOKING_DATABASE_NAME. */
const BOOKING_DATABASE_NAME = "booking_db";

/**
 * Convert untrusted environment strings into a typed AppConfig.
 * Does not read process.env — caller passes the environment object.
 */
export function parseConfig(environment: Environment): AppConfig {
  const port = parsePort(environment.PORT);
  const jwtSecret = parseJwtSecret(environment.JWT_SECRET);
  const rabbitmqUrl = parseRabbitmqUrl(environment.RABBITMQ_URL);
  const postgres = parsePostgresConfig(environment);

  return {
    port,
    jwtSecret,
    rabbitmqUrl,
    postgres,
  };
}

function parsePostgresConfig(environment: Environment): PostgresConfig {
  return {
    host: environment.POSTGRES_HOST?.trim() || DEFAULT_POSTGRES_HOST,
    port: parsePostgresPort(environment.POSTGRES_PORT),
    username: parseRequired(
      "BOOKING_POSTGRES_USER",
      environment.BOOKING_POSTGRES_USER,
    ),
    password: parseRequired(
      "BOOKING_POSTGRES_PASSWORD",
      environment.BOOKING_POSTGRES_PASSWORD,
    ),
    database: BOOKING_DATABASE_NAME,
  };
}

function parseRequired(name: string, raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error(`Missing required configuration: ${name}`);
  }

  const value = raw.trim();

  if (value.length === 0) {
    throw new Error(`Invalid ${name}: value must not be blank`);
  }

  return value;
}

function parsePostgresPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_POSTGRES_PORT;
  }

  const trimmed = raw.trim();

  if (!/^\d+$/.test(trimmed)) {
    throw new Error("Invalid POSTGRES_PORT: expected an integer 1–65535");
  }

  const port = Number(trimmed);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid POSTGRES_PORT: expected an integer 1–65535");
  }

  return port;
}

const MIN_JWT_SECRET_LENGTH = 32;

function parseJwtSecret(raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error("Missing required configuration: JWT_SECRET");
  }

  const secret = raw.trim();

  if (secret.length === 0) {
    throw new Error("Invalid JWT_SECRET: value must not be blank");
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `Invalid JWT_SECRET: expected at least ${MIN_JWT_SECRET_LENGTH} characters`,
    );
  }

  return secret;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }

  const trimmed = raw.trim();

  if (trimmed === "") {
    throw new Error(
      "Invalid PORT: value is blank; omit PORT to use the default 3000",
    );
  }

  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      "Invalid PORT: expected an integer between 1 and 65535",
    );
  }

  const port = Number(trimmed);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      "Invalid PORT: expected an integer between 1 and 65535",
    );
  }

  return port;
}

function parseRabbitmqUrl(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_RABBITMQ_URL;
  }

  const trimmed = raw.trim();

  if (trimmed === "") {
    throw new Error(
      "Invalid RABBITMQ_URL: value is blank; omit RABBITMQ_URL to use the default amqp://guest:guest@localhost:5672",
    );
  }

  return trimmed;
}

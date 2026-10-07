export type IdentityConfig = Readonly<{
  port: number;
  postgres: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
}>;

type Environment = Record<string, string | undefined>;

const DEFAULT_PORT = 3001;
const DEFAULT_JWT_EXPIRES_IN = "1h";
const MIN_JWT_SECRET_LENGTH = 32;
/** Fixed, not env-driven — see docker/postgres-init/00-create-identity-db.sh.
 * POSTGRES_DB no longer means "identity_db": it now names the Postgres
 * container's own maintenance database, read only by the init scripts. */
const IDENTITY_DATABASE_NAME = "identity_db";

/**
 * Day 42: username/password are fail-fast (IDENTITY_POSTGRES_USER/PASSWORD,
 * no default) — same reasoning as jwtSecret, no default credential is safe
 * to bake into source. Previously this read POSTGRES_USER/PASSWORD with
 * soft defaults, which happened to be the exact same env var names the
 * Postgres container's image bootstraps its cluster SUPERUSER from — so
 * identity was unknowingly connecting as the superuser (Day 40 review point
 * #1). IDENTITY_POSTGRES_USER/PASSWORD are new, separate names, mirroring
 * how api/src/config.ts already does this for BOOKING_POSTGRES_USER/
 * PASSWORD (Day 40).
 */
export function parseIdentityConfig(environment: Environment): IdentityConfig {
  return {
    port: parsePort(environment.IDENTITY_PORT ?? environment.PORT),
    postgres: {
      host: environment.POSTGRES_HOST?.trim() || "localhost",
      port: parsePostgresPort(environment.POSTGRES_PORT),
      username: parseRequired(
        "IDENTITY_POSTGRES_USER",
        environment.IDENTITY_POSTGRES_USER,
      ),
      password: parseRequired(
        "IDENTITY_POSTGRES_PASSWORD",
        environment.IDENTITY_POSTGRES_PASSWORD,
      ),
      database: IDENTITY_DATABASE_NAME,
    },
    jwt: {
      secret: parseJwtSecret(environment.JWT_SECRET),
      expiresIn: parseJwtExpiresIn(environment.JWT_EXPIRES_IN),
    },
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

function parseJwtExpiresIn(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_JWT_EXPIRES_IN;
  }

  return raw.trim();
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(raw.trim())) {
    throw new Error("Invalid IDENTITY_PORT: expected an integer 1–65535");
  }

  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid IDENTITY_PORT: expected an integer 1–65535");
  }

  return port;
}

function parsePostgresPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 5432;
  }

  if (!/^\d+$/.test(raw.trim())) {
    throw new Error("Invalid POSTGRES_PORT: expected an integer 1–65535");
  }

  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid POSTGRES_PORT: expected an integer 1–65535");
  }

  return port;
}

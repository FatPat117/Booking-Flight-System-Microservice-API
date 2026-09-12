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

export function parseIdentityConfig(environment: Environment): IdentityConfig {
  return {
    port: parsePort(environment.IDENTITY_PORT ?? environment.PORT),
    postgres: {
      host: environment.POSTGRES_HOST?.trim() || "localhost",
      port: parsePostgresPort(environment.POSTGRES_PORT),
      username: environment.POSTGRES_USER?.trim() || "identity",
      password:
        environment.POSTGRES_PASSWORD?.trim() || "identity_dev_password",
      database: environment.POSTGRES_DB?.trim() || "identity_db",
    },
    jwt: {
      secret: parseJwtSecret(environment.JWT_SECRET),
      expiresIn: parseJwtExpiresIn(environment.JWT_EXPIRES_IN),
    },
  };
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

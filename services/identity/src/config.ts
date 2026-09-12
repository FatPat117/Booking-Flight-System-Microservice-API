export type IdentityConfig = Readonly<{
  port: number;
  postgres: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
}>;

type Environment = Record<string, string | undefined>;

const DEFAULT_PORT = 3001;

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
  };
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

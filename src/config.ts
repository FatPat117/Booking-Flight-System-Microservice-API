export type AppConfig = Readonly<{
  port: number;
  databasePath: string;
  adminApiKey: string;
}>;

type Environment = Record<string, string | undefined>;

const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = "data/booking.db";

/**
 * Convert untrusted environment strings into a typed AppConfig.
 * Does not read process.env — caller passes the environment object.
 */
export function parseConfig(environment: Environment): AppConfig {
  const port = parsePort(environment.PORT);
  const databasePath = parseDatabasePath(environment.DATABASE_PATH);
  const adminApiKey = parseAdminApiKey(environment.ADMIN_API_KEY);

  return {
    port,
    databasePath,
    adminApiKey,
  };
}

function parseAdminApiKey(raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error("Missing required configuration: ADMIN_API_KEY");
  }

  const adminApiKey = raw.trim();

  if (adminApiKey.length === 0) {
    throw new Error("Invalid ADMIN_API_KEY: value must not be blank");
  }

  if (adminApiKey.length < 16) {
    throw new Error(
      "Invalid ADMIN_API_KEY: expected at least 16 characters",
    );
  }

  return adminApiKey;
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

function parseDatabasePath(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_DATABASE_PATH;
  }

  const trimmed = raw.trim();

  if (trimmed === "") {
    throw new Error(
      "Invalid DATABASE_PATH: value is blank; omit DATABASE_PATH to use the default data/booking.db",
    );
  }

  return trimmed;
}

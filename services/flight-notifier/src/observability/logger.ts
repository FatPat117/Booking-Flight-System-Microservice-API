export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  message: string;
} & LogFields;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** ISO-8601 timestamp in Vietnam time (UTC+7). */
function formatVietnamTimestamp(date = new Date()): string {
  const vietnamOffsetMs = 7 * 60 * 60 * 1000;
  return new Date(date.getTime() + vietnamOffsetMs)
    .toISOString()
    .replace("Z", "+07:00");
}

function write(level: LogLevel, message: string, fields: LogFields = {}) {
  const line = JSON.stringify({
    timestamp: formatVietnamTimestamp(),
    level,
    message,
    ...fields,
  });

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export function createConsoleLogger(): Logger {
  return {
    info(message, fields) {
      write("info", message, fields);
    },
    warn(message, fields) {
      write("warn", message, fields);
    },
    error(message, fields) {
      write("error", message, fields);
    },
  };
}

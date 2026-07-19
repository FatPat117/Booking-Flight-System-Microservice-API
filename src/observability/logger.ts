import { getRequestContext } from "./request-context.js";

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
} & LogFields;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** ISO-8601 timestamp in Vietnam time (UTC+7), e.g. 2026-07-19T18:25:59.631+07:00 */
function formatVietnamTimestamp(date = new Date()): string {
  const vietnamOffsetMs = 7 * 60 * 60 * 1000;
  return new Date(date.getTime() + vietnamOffsetMs)
    .toISOString()
    .replace("Z", "+07:00");
}

function createLogEntry(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
): LogEntry {
  const context = getRequestContext();

  return {
    timestamp: formatVietnamTimestamp(),
    level,
    message,
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    ...fields,
  };
}

function write(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
) {
  const entry = createLogEntry(level, message, fields);
  const line = JSON.stringify(entry);

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

import { DatabaseSync } from "node:sqlite";

const createFlightsTable = `
CREATE TABLE IF NOT EXISTS flights (
  id TEXT PRIMARY KEY NOT NULL,
  flight_number TEXT NOT NULL,
  origin TEXT NOT NULL
    CHECK (length(origin) = 3),
  destination TEXT NOT NULL
    CHECK (length(destination) = 3),
  departure_at TEXT NOT NULL,
  arrival_at TEXT NOT NULL,
  price_in_cents INTEGER NOT NULL
    CHECK (price_in_cents > 0),
  currency TEXT NOT NULL
    CHECK (currency IN ('VND', 'USD')),
  available_seats INTEGER NOT NULL
    CHECK (available_seats >= 0),
  CHECK (origin <> destination),
  CHECK (arrival_at > departure_at),
  UNIQUE (flight_number, departure_at)
) STRICT;
`;

const createAuditLogsTable = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,

  action TEXT NOT NULL,

  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,

  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,

  request_id TEXT,

  occurred_at TEXT NOT NULL,

  metadata_json TEXT NOT NULL,

  CHECK (length(action) > 0),
  CHECK (length(actor_type) > 0),
  CHECK (length(actor_id) > 0),
  CHECK (length(target_type) > 0),
  CHECK (length(target_id) > 0),
  CHECK (length(occurred_at) > 0),
  CHECK (length(metadata_json) > 0)
) STRICT;
`;

const createAuditLogsIndexes = `
CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at
ON audit_logs (occurred_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_target
ON audit_logs (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id
ON audit_logs (request_id);
`;

/**
 * Open SQLite and ensure schema exists.
 * Caller chooses the path (:memory: | temp file | data/booking.db).
 */
export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(createFlightsTable);
  database.exec(createAuditLogsTable);
  database.exec(createAuditLogsIndexes);
  return database;
}

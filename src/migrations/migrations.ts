import type { Migration } from "./migration.js";

const createFlightsMigration: Migration = {
  id: "001_create_flights",

  up(database) {
    database.exec(`
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
    `);
  },
};

const createAuditLogsMigration: Migration = {
  id: "002_create_audit_logs",

  up(database) {
    database.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at
      ON audit_logs (occurred_at);

      CREATE INDEX IF NOT EXISTS idx_audit_logs_target
      ON audit_logs (target_type, target_id);

      CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id
      ON audit_logs (request_id);
    `);
  },
};

const createOutboxMigration: Migration = {
  id: "003_create_outbox",

  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT,
        CHECK (length(event_type) > 0),
        CHECK (length(payload) > 0),
        CHECK (length(created_at) > 0)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
      ON outbox (published_at)
      WHERE published_at IS NULL;
    `);
  },
};

export const migrations: readonly Migration[] = [
  createFlightsMigration,
  createAuditLogsMigration,
  createOutboxMigration,
];

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

/**
 * Open SQLite and ensure schema exists.
 * Caller chooses the path (:memory: | temp file | data/booking.db).
 */
export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(createFlightsTable);
  return database;
}

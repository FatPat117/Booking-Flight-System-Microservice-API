import { DatabaseSync } from "node:sqlite";

import { runMigrations } from "./migrations/migration-runner.js";
import { migrations } from "./migrations/migrations.js";

/**
 * Open SQLite and apply pending migrations.
 * Caller chooses the path (:memory: | temp file | data/booking.db).
 */
export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);

  try {
    runMigrations(database, migrations);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

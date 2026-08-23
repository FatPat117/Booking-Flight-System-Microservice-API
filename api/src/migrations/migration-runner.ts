import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./migration.js";

const CREATE_SCHEMA_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

type AppliedMigrationRow = {
  id: string;
};

export function runMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[],
): void {
  database.exec(CREATE_SCHEMA_MIGRATIONS_TABLE);

  const appliedRows = database
    .prepare(
      `
      SELECT id
      FROM schema_migrations
    `,
    )
    .all() as AppliedMigrationRow[];

  const appliedMigrationIds = new Set(
    appliedRows.map((row) => row.id),
  );

  const insertAppliedMigration = database.prepare(`
    INSERT INTO schema_migrations (
      id,
      applied_at
    )
    VALUES (?, ?)
  `);

  for (const migration of migrations) {
    if (appliedMigrationIds.has(migration.id)) {
      continue;
    }

    database.exec("BEGIN IMMEDIATE");

    try {
      migration.up(database);

      insertAppliedMigration.run(
        migration.id,
        new Date().toISOString(),
      );

      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Do not hide the original migration error.
      }

      throw error;
    }
  }
}

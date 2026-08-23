import type { DatabaseSync } from "node:sqlite";

import type { OutboxEntry, OutboxRepository } from "./outbox-repository.js";

type OutboxRow = {
  id: string;
  event_type: string;
  payload: string;
  created_at: string;
};

export function createSqliteOutboxRepository(
  database: DatabaseSync,
): OutboxRepository {
  const insertOutbox = database.prepare(`
    INSERT INTO outbox (id, event_type, payload, created_at, published_at)
    VALUES (?, ?, ?, ?, NULL)
  `);

  const selectUnpublished = database.prepare(`
    SELECT id, event_type, payload, created_at
    FROM outbox
    WHERE published_at IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `);

  const markPublishedStatement = database.prepare(`
    UPDATE outbox
    SET published_at = ?
    WHERE id = ?
  `);

  return {
    enqueue(entry) {
      insertOutbox.run(
        entry.id,
        entry.eventType,
        JSON.stringify(entry.payload),
        entry.createdAt,
      );
    },

    findUnpublished(limit) {
      const rows = selectUnpublished.all(limit) as OutboxRow[];

      return rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        payload: JSON.parse(row.payload) as unknown,
        createdAt: row.created_at,
      }));
    },

    markPublished(id) {
      markPublishedStatement.run(new Date().toISOString(), id);
    },
  };
}

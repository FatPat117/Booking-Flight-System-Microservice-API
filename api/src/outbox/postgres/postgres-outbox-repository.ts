import type { DataSource } from "typeorm";
import { IsNull } from "typeorm";

import {
  isInTransaction,
  resolveEntityManager,
} from "../../postgres/transaction-context.js";
import type { OutboxEntry, OutboxRepository } from "../outbox-repository.js";
import { OutboxEntity } from "./outbox.entity.js";

/**
 * Deliberate asymmetry with SqliteOutboxRepository (which has no such
 * check): enqueue() only exists to be atomic with the business write beside
 * it (ADR-001) — calling it outside a transaction on Postgres is a
 * programmer error worth failing loudly for, the same way
 * NestedTransactionError and setAuthenticatedUser (request-context.ts) fail
 * loudly on their own kind of context misuse. SQLite can't cheaply detect
 * this the same way without adopting the same AsyncLocalStorage machinery
 * for a problem it hasn't caused a bug yet.
 */
export class OutboxEnqueueOutsideTransactionError extends Error {
  constructor() {
    super(
      "OutboxRepository.enqueue() was called with no active transaction. " +
        "enqueue() only exists to be atomic with the business write beside " +
        "it (ADR-001) — call it from inside transactionRunner.run().",
    );
    this.name = "OutboxEnqueueOutsideTransactionError";
  }
}

/**
 * OutboxEntity uses Date (TIMESTAMPTZ) and a real jsonb payload; the domain
 * OutboxEntry uses an ISO string for createdAt and payload: unknown (already
 * storage-agnostic). This boundary is the only place that converts between
 * them, same rule as postgres-flight-repository.ts's mapFlight().
 */
function mapOutbox(entity: OutboxEntity): OutboxEntry {
  return {
    id: entity.id,
    eventType: entity.eventType,
    payload: entity.payload,
    createdAt: entity.createdAt.toISOString(),
  };
}

export function createPostgresOutboxRepository(
  dataSource: DataSource,
): OutboxRepository {
  return {
    async enqueue(entry: OutboxEntry): Promise<void> {
      if (!isInTransaction()) {
        throw new OutboxEnqueueOutsideTransactionError();
      }

      const repository =
        resolveEntityManager(dataSource).getRepository(OutboxEntity);

      const entity = repository.create({
        id: entry.id,
        eventType: entry.eventType,
        payload: entry.payload,
        createdAt: new Date(entry.createdAt),
        publishedAt: null,
      });

      await repository.insert(entity);
    },

    async findUnpublished(limit: number): Promise<OutboxEntry[]> {
      const repository =
        resolveEntityManager(dataSource).getRepository(OutboxEntity);

      const entities = await repository.find({
        where: { publishedAt: IsNull() },
        order: { createdAt: "ASC" },
        take: limit,
      });

      return entities.map(mapOutbox);
    },

    async markPublished(id: string): Promise<void> {
      const repository =
        resolveEntityManager(dataSource).getRepository(OutboxEntity);

      await repository.update({ id }, { publishedAt: new Date() });
    },
  };
}

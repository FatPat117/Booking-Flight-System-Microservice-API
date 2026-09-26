import type { DataSource } from "typeorm";

import {
  isInTransaction,
  resolveEntityManager,
} from "../../postgres/transaction-context.js";
import type { AuditRecordInput, AuditRecorder } from "../audit-recorder.js";
import { AuditEntity } from "./audit.entity.js";

/**
 * Same reasoning as OutboxEnqueueOutsideTransactionError (Day 37): a record()
 * call only exists to be atomic with the business write beside it — an audit
 * row written outside a transaction could survive a rollback of the action
 * it's supposed to describe, i.e. the log would lie. Postgres can cheaply
 * detect this via transaction-context; SqliteAuditRecorder has no such check
 * for the same reason SqliteOutboxRepository doesn't.
 */
export class AuditRecordOutsideTransactionError extends Error {
  constructor() {
    super(
      "AuditRecorder.record() was called with no active transaction. " +
        "record() only exists to be atomic with the business write it " +
        "describes — call it from inside transactionRunner.run().",
    );
    this.name = "AuditRecordOutsideTransactionError";
  }
}

export function createPostgresAuditRecorder(
  dataSource: DataSource,
): AuditRecorder {
  return {
    async record(input: AuditRecordInput): Promise<void> {
      if (!isInTransaction()) {
        throw new AuditRecordOutsideTransactionError();
      }

      const repository =
        resolveEntityManager(dataSource).getRepository(AuditEntity);

      const entity = repository.create({
        id: input.id,
        action: input.action,
        actorType: input.actor.type,
        actorId: input.actor.id,
        targetType: input.target.type,
        targetId: input.target.id,
        requestId: input.requestId ?? null,
        occurredAt: new Date(input.occurredAt),
        metadata: input.metadata,
      });

      await repository.insert(entity);
    },
  };
}

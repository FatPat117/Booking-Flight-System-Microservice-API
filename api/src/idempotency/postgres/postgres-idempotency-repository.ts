import type { DataSource } from "typeorm";

import { resolveEntityManager } from "../../postgres/transaction-context.js";
import type {
  ClaimResult,
  IdempotencyRepository,
  IdempotencyScope,
} from "../idempotency-repository.js";

type IdempotencyRow = {
  request_fingerprint: string;
  status: "IN_PROGRESS" | "COMPLETED";
  response_status: number | null;
  response_body: unknown;
};

/** A claim races a release at most this many times before it is a bug. */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * TypeORM's query() returns the rows for an INSERT … RETURNING, and
 * [rows, rowCount] for an UPDATE or DELETE.
 *
 * Raw SQL, like the booking adapter's lifecycle statements: the claim is one
 * INSERT … ON CONFLICT DO NOTHING on the primary key. Postgres makes a second
 * claim of a key whose insert is not yet committed wait for that transaction,
 * then report the conflict (or insert, if the first rolled back) — no 23505,
 * so the caller's transaction is never aborted by a lost claim.
 */
export function createPostgresIdempotencyRepository(
  dataSource: DataSource,
): IdempotencyRepository {
  function scopeParams(scope: IdempotencyScope, key: string) {
    return [scope.accountId, scope.operation, key];
  }

  return {
    async claim(scope, key, fingerprint, now): Promise<ClaimResult> {
      const manager = resolveEntityManager(dataSource);

      for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
        const inserted = (await manager.query(
          `INSERT INTO "idempotency_keys"
             ("account_id", "operation", "key", "request_fingerprint", "status", "created_at")
           VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5)
           ON CONFLICT DO NOTHING
           RETURNING 1`,
          [...scopeParams(scope, key), fingerprint, now],
        )) as unknown[];

        if (inserted.length === 1) {
          return { outcome: "claimed" };
        }

        const [row] = (await manager.query(
          `SELECT "request_fingerprint", "status", "response_status", "response_body"
           FROM "idempotency_keys"
           WHERE "account_id" = $1 AND "operation" = $2 AND "key" = $3`,
          scopeParams(scope, key),
        )) as IdempotencyRow[];

        // Released between our INSERT and SELECT: the key is free again.
        if (row === undefined) {
          continue;
        }

        if (row.status === "IN_PROGRESS") {
          return { outcome: "in-progress", fingerprint: row.request_fingerprint };
        }

        if (row.response_status === null) {
          throw new Error(`Completed idempotency key ${key} has no response`);
        }

        return {
          outcome: "completed",
          fingerprint: row.request_fingerprint,
          response: { status: row.response_status, body: row.response_body },
        };
      }

      throw new Error(
        `Idempotency key ${key} could not be claimed after ${MAX_CLAIM_ATTEMPTS} attempts`,
      );
    },

    async attachPayment(scope, key, paymentId) {
      const updated = (await resolveEntityManager(dataSource).query(
        `UPDATE "idempotency_keys" SET "payment_id" = $4
         WHERE "account_id" = $1 AND "operation" = $2 AND "key" = $3
           AND "status" = 'IN_PROGRESS'`,
        [...scopeParams(scope, key), paymentId],
      )) as [unknown[], number];

      if (updated[1] !== 1) {
        throw new Error(`Idempotency key ${key} is not in progress`);
      }
    },

    async complete(scope, key, response, now) {
      const updated = (await resolveEntityManager(dataSource).query(
        `UPDATE "idempotency_keys"
         SET "status" = 'COMPLETED', "response_status" = $4,
             "response_body" = $5::json, "completed_at" = $6
         WHERE "account_id" = $1 AND "operation" = $2 AND "key" = $3
           AND "status" = 'IN_PROGRESS'`,
        [
          ...scopeParams(scope, key),
          response.status,
          JSON.stringify(response.body),
          now,
        ],
      )) as [unknown[], number];

      if (updated[1] !== 1) {
        throw new Error(`Idempotency key ${key} is not in progress`);
      }
    },

    async release(scope, key) {
      await resolveEntityManager(dataSource).query(
        `DELETE FROM "idempotency_keys"
         WHERE "account_id" = $1 AND "operation" = $2 AND "key" = $3
           AND "status" = 'IN_PROGRESS'`,
        scopeParams(scope, key),
      );
    },
  };
}

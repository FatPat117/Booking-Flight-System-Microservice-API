import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 49B — HTTP Idempotency-Key records (domain-model Decision 14).
 *
 * - Primary key (account_id, operation, key): the same key string from two
 *   accounts, or for two operations, is two records that never see each
 *   other (Day 44: every lookup carries the owner). The claim is an INSERT …
 *   ON CONFLICT DO NOTHING on this key.
 * - request_fingerprint: SHA-256 of the canonicalised method, path and
 *   validated body. Same key + different fingerprint = 422
 *   IDEMPOTENCY_KEY_REUSED (BR-PAY-02).
 * - response_status / response_body are written in the same transaction as
 *   the business outcome they describe, so a COMPLETED key can never
 *   disagree with the data. CHK_idempotency_keys_completed makes "completed
 *   without a response" unrepresentable.
 * - response_body is `json`, not `jsonb`: a replay must be the response
 *   byte for byte, and jsonb stores a normalised copy with its keys
 *   reordered (found by the Day 49B e2e). Nothing queries inside the body.
 * - payment_id is NULL until phase 1 has created the payment, and stays NULL
 *   for an outcome that never had one (404, not payable).
 * - IDX_idempotency_keys_created_at: cleanup of keys older than 24 h (49C).
 */
export class CreateIdempotencyKeys1790515600000 implements MigrationInterface {
  name = "CreateIdempotencyKeys1790515600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "idempotency_keys" (
        "account_id" uuid NOT NULL,
        "operation" text NOT NULL,
        "key" text NOT NULL,
        "request_fingerprint" text NOT NULL,
        "status" text NOT NULL,
        "response_status" integer NULL,
        "response_body" json NULL,
        "payment_id" uuid NULL,
        "created_at" timestamptz NOT NULL,
        "completed_at" timestamptz NULL,
        CONSTRAINT "PK_idempotency_keys"
          PRIMARY KEY ("account_id", "operation", "key"),
        CONSTRAINT "FK_idempotency_keys_payment_id" FOREIGN KEY ("payment_id")
          REFERENCES "payments" ("id"),
        CONSTRAINT "CHK_idempotency_keys_operation"
          CHECK ("operation" IN ('pay-booking')),
        CONSTRAINT "CHK_idempotency_keys_key_length"
          CHECK (char_length("key") BETWEEN 1 AND 255),
        CONSTRAINT "CHK_idempotency_keys_status"
          CHECK ("status" IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT "CHK_idempotency_keys_completed" CHECK (
          ("status" = 'COMPLETED') = (
            "response_status" IS NOT NULL
            AND "response_body" IS NOT NULL
            AND "completed_at" IS NOT NULL
          )
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_idempotency_keys_created_at"
      ON "idempotency_keys" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_keys"`);
  }
}

import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 49C — what reconciliation needs on a payment (domain-model Decision 15,
 * ADR-010).
 *
 * - payment_method_token: reconciliation charges a PROCESSING payment again
 *   with its own id, which needs the token it was started with. Kept only
 *   while PROCESSING (CHK_payments_token): every transition out of it clears
 *   the token, so a finished payment holds no reusable reference to a card.
 * - next_attempt_at: when reconciliation may touch the payment next. One
 *   column is the age gate (phase 1 sets it past the live request's own
 *   timeout), the lease (the job's claim moves it forward) and the retry
 *   backoff. Set exactly while the payment is PROCESSING or REFUND_PENDING
 *   (CHK_payments_next_attempt), so a finished payment can never be picked.
 * - attempts: reconciliation attempts in the current state; BR-PAY-09 stops
 *   refunds after 5.
 * - REFUND_FAILED: a refund that cannot be made by the system any more
 *   (BR-PAY-09). Money was taken, so it carries a provider reference too.
 * - IDX_payments_due: the job's query, "non-terminal payments due by now,
 *   oldest first", partial like idx_bookings_held_expiry (Day 48B), so it
 *   only ever holds payments in flight.
 * - UQ_idempotency_keys_payment_id: phase 3 — the request's and the job's,
 *   one shared code path — completes the key by the payment it started (the
 *   job knows no account or key). Unique because a payment is started by
 *   exactly one key.
 *
 * Existing rows: non-terminal payments become due now. A PROCESSING payment
 * has no token to charge again with — the migration refuses with the list,
 * since inventing a token would charge with a payment method nobody chose.
 */
export class AddPaymentReconciliation1790519200000 implements MigrationInterface {
  name = "AddPaymentReconciliation1790519200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        problems text;
      BEGIN
        SELECT string_agg(format('  payment %s (booking %s)', p.id, p.booking_id),
                          E'\\n' ORDER BY p.created_at, p.id)
        INTO problems
        FROM payments p
        WHERE p.status = 'PROCESSING';

        IF problems IS NOT NULL THEN
          RAISE EXCEPTION E'PROCESSING payments without a payment method token:\\n%', problems
            USING HINT = 'Reconciliation charges them again and needs the token they were '
              || 'started with, which was never stored. Check each one with the provider '
              || 'and finish it by hand (FAILED with a failure_reason, or SUCCEEDED with a '
              || 'provider_reference). Then run migrations again.';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN "payment_method_token" text NULL,
        ADD COLUMN "attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN "next_attempt_at" timestamptz NULL
    `);

    await queryRunner.query(`
      UPDATE "payments" SET "next_attempt_at" = now()
      WHERE "status" = 'REFUND_PENDING'
    `);

    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT "CHK_payments_status",
        DROP CONSTRAINT "CHK_payments_provider_reference",
        ADD CONSTRAINT "CHK_payments_status" CHECK ("status" IN
          ('PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')),
        ADD CONSTRAINT "CHK_payments_provider_reference" CHECK (
          "status" NOT IN ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')
          OR "provider_reference" IS NOT NULL
        ),
        ADD CONSTRAINT "CHK_payments_token" CHECK (
          ("status" = 'PROCESSING') = ("payment_method_token" IS NOT NULL)
        ),
        ADD CONSTRAINT "CHK_payments_next_attempt" CHECK (
          ("status" IN ('PROCESSING', 'REFUND_PENDING')) = ("next_attempt_at" IS NOT NULL)
        ),
        ADD CONSTRAINT "CHK_payments_attempts" CHECK ("attempts" >= 0)
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_payments_due"
      ON "payments" ("next_attempt_at", "id")
      WHERE "status" IN ('PROCESSING', 'REFUND_PENDING')
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_idempotency_keys_payment_id"
      ON "idempotency_keys" ("payment_id") WHERE "payment_id" IS NOT NULL
    `);
  }

  /** Refuses (CHK_payments_status) while a REFUND_FAILED payment exists. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_idempotency_keys_payment_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payments_due"`);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT "CHK_payments_attempts",
        DROP CONSTRAINT "CHK_payments_next_attempt",
        DROP CONSTRAINT "CHK_payments_token",
        DROP CONSTRAINT "CHK_payments_provider_reference",
        DROP CONSTRAINT "CHK_payments_status",
        ADD CONSTRAINT "CHK_payments_status" CHECK ("status" IN
          ('PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED')),
        ADD CONSTRAINT "CHK_payments_provider_reference" CHECK (
          "status" NOT IN ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED')
          OR "provider_reference" IS NOT NULL
        )
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN "next_attempt_at",
        DROP COLUMN "attempts",
        DROP COLUMN "payment_method_token"
    `);
  }
}

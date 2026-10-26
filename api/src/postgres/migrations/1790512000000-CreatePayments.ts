import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 49B — payments (domain-model Decision 14, ADR-009).
 *
 * - A row is written in phase 1 as PROCESSING, before the gateway is called,
 *   so a repeated request, a restart and reconciliation (49C) can all see
 *   that a payment has started. The other states are written in phase 3 or
 *   after a refund.
 * - account_id is the payer (the booking's owner, JWT `sub`). No FK: accounts
 *   live in identity's database, like bookings.owner_account_id.
 * - amount_vnd is captured from the booking total in phase 1: whole đồng,
 *   bigint, capped at 2^53 − 1 like flight_fares (Decision 13).
 * - CHK_payments_provider_reference / CHK_payments_failure_reason tie the
 *   state to its data: money that was taken always has the gateway's
 *   reference, a FAILED payment always says why.
 * - UQ_payments_booking_succeeded: BR-PAY-05, at most one SUCCEEDED payment
 *   per booking, enforced by the database, not by the Idempotency-Key (which
 *   only stops a *repeated* request, not two different ones).
 * - UQ_payments_booking_processing: at most one payment in flight per
 *   booking. Phase 1 inserts with ON CONFLICT ("booking_id") WHERE "status" =
 *   'PROCESSING' DO NOTHING, so a second, different request gets a clean
 *   "payment-in-progress" instead of a 23505 that would abort its
 *   transaction (ADR-004 Day 38 addendum). It also serves "find the payment
 *   in flight for this booking" (49C).
 */
export class CreatePayments1790512000000 implements MigrationInterface {
  name = "CreatePayments1790512000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id" uuid NOT NULL,
        "booking_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "amount_vnd" bigint NOT NULL,
        "status" text NOT NULL,
        "provider_reference" text NULL,
        "failure_reason" text NULL,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        CONSTRAINT "PK_payments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payments_booking_id" FOREIGN KEY ("booking_id")
          REFERENCES "bookings" ("id"),
        CONSTRAINT "CHK_payments_status" CHECK ("status" IN
          ('PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED')),
        CONSTRAINT "CHK_payments_amount_positive" CHECK ("amount_vnd" > 0),
        CONSTRAINT "CHK_payments_amount_safe"
          CHECK ("amount_vnd" <= 9007199254740991),
        CONSTRAINT "CHK_payments_provider_reference" CHECK (
          "status" NOT IN ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED')
          OR "provider_reference" IS NOT NULL
        ),
        CONSTRAINT "CHK_payments_failure_reason" CHECK (
          "status" <> 'FAILED' OR "failure_reason" IS NOT NULL
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_payments_booking_succeeded"
      ON "payments" ("booking_id") WHERE "status" = 'SUCCEEDED'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_payments_booking_processing"
      ON "payments" ("booking_id") WHERE "status" = 'PROCESSING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
  }
}

import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 46 — expand (1 of 3). Adds the columns flights will need, all nullable,
 * so existing rows stay valid. Nothing reads them yet.
 *
 * Phase D step 3: flights reference airports and aircraft by id (domain-model
 * Decision 6) and get a stored status (SCHEDULED / OPEN / CANCELLED — CLOSED
 * and DEPARTED are derived from the clock, ADR-008).
 *
 * Migrations run one transaction each (data-source.ts), so when the contract
 * step refuses, this one stays applied and the columns exist for a manual
 * backfill.
 */
export class ExpandFlightReferences1790450800000 implements MigrationInterface {
  name = "ExpandFlightReferences1790450800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flights"
        ADD COLUMN "origin_airport_id" uuid,
        ADD COLUMN "destination_airport_id" uuid,
        ADD COLUMN "aircraft_id" uuid,
        ADD COLUMN "status" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "flights"
        DROP COLUMN IF EXISTS "status",
        DROP COLUMN IF EXISTS "aircraft_id",
        DROP COLUMN IF EXISTS "destination_airport_id",
        DROP COLUMN IF EXISTS "origin_airport_id"
    `);
  }
}

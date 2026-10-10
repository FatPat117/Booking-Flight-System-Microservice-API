import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Day 46 — backfill (2 of 3). The first backfill in this project with real
 * logic rather than "reset dev data":
 *
 * - Airports: `origin`/`destination` were free 3-letter text; airports.code
 *   is the normalized IATA code (Day 45), so the match is on upper(text).
 *   A flight whose code is not a registered airport keeps NULL — the
 *   contract step names it instead of guessing.
 * - Aircraft: not backfilled. Old flights carry no aircraft information, so
 *   which aircraft flew them is a human decision (assign one, or delete the
 *   flight). The contract step refuses until that is done.
 * - Status: existing flights were bookable before statuses existed, so they
 *   become OPEN. New flights start SCHEDULED (set by the application).
 *
 * Idempotent: only fills NULLs, so re-running after a refused contract is
 * safe.
 */
export class BackfillFlightReferences1790454400000 implements MigrationInterface {
  name = "BackfillFlightReferences1790454400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "flights" f
      SET "origin_airport_id" = a."id"
      FROM "airports" a
      WHERE f."origin_airport_id" IS NULL AND a."code" = upper(f."origin")
    `);

    await queryRunner.query(`
      UPDATE "flights" f
      SET "destination_airport_id" = a."id"
      FROM "airports" a
      WHERE f."destination_airport_id" IS NULL
        AND a."code" = upper(f."destination")
    `);

    await queryRunner.query(`
      UPDATE "flights" SET "status" = 'OPEN' WHERE "status" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "flights"
      SET "origin_airport_id" = NULL,
          "destination_airport_id" = NULL,
          "status" = NULL
    `);
  }
}

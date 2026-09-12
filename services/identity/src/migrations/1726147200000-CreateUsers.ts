import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Hand-written first migration (reviewed SQL — not blind generate trust).
 * UNIQUE(email) is the last-line race safety for concurrent register.
 */
export class CreateUsers1726147200000 implements MigrationInterface {
  name = "CreateUsers1726147200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying NOT NULL,
        "password_hash" character varying NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}

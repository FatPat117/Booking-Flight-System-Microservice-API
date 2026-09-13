import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddRoleToUsers1726300000000 implements MigrationInterface {
  name = "AddRoleToUsers1726300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "role" varchar NOT NULL DEFAULT 'user'
      CONSTRAINT "CHK_users_role" CHECK ("role" IN ('user', 'admin'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT "CHK_users_role"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "role"
    `);
  }
}

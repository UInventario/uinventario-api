import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserAccessRetirement1788138000000 implements MigrationInterface {
  name = 'AddUserAccessRetirement1788138000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      ADD COLUMN access_revoked_at DATETIME(6) NULL AFTER password_hash,
      ADD KEY ix_users_access_revoked (tenant_id, access_revoked_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
      DROP KEY ix_users_access_revoked,
      DROP COLUMN access_revoked_at
    `);
  }
}

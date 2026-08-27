import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProductVersion1787853600000 implements MigrationInterface {
  name = 'AddProductVersion1787853600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER active,
      ADD COLUMN updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6) AFTER created_at
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE products DROP COLUMN updated_at, DROP COLUMN version',
    );
  }
}

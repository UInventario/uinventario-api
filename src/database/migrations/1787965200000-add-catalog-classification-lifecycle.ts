import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCatalogClassificationLifecycle1787965200000 implements MigrationInterface {
  name = 'AddCatalogClassificationLifecycle1787965200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['categories', 'brands']) {
      await queryRunner.query(`ALTER TABLE ${table}
        ADD active BOOLEAN NOT NULL DEFAULT TRUE AFTER normalized_name,
        ADD updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6) AFTER created_at`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['brands', 'categories']) {
      await queryRunner.query(
        `ALTER TABLE ${table} DROP COLUMN updated_at, DROP COLUMN active`,
      );
    }
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyProfile1787824800000 implements MigrationInterface {
  name = 'AddCompanyProfile1787824800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenants
      ADD legal_name VARCHAR(160) NULL,
      ADD country_code CHAR(2) NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenants
      DROP COLUMN country_code,
      DROP COLUMN legal_name
    `);
  }
}

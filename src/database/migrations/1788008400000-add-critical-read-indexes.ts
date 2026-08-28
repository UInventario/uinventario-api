import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCriticalReadIndexes1788008400000 implements MigrationInterface {
  name = 'AddCriticalReadIndexes1788008400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD KEY ix_products_tenant_active_created (tenant_id, active, created_at, id)
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      ADD KEY ix_sales_tenant_branch_created (tenant_id, branch_id, created_at, id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sales DROP KEY ix_sales_tenant_branch_created
    `);
    await queryRunner.query(`
      ALTER TABLE products DROP KEY ix_products_tenant_active_created
    `);
  }
}

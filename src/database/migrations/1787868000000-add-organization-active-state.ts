import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrganizationActiveState1787868000000 implements MigrationInterface {
  name = 'AddOrganizationActiveState1787868000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE branches
      ADD active BOOLEAN NOT NULL DEFAULT TRUE AFTER timezone,
      ADD UNIQUE KEY uq_branches_tenant_name (tenant_id, name)
    `);
    await queryRunner.query(`
      ALTER TABLE warehouses
      ADD active BOOLEAN NOT NULL DEFAULT TRUE AFTER name,
      ADD UNIQUE KEY uq_warehouses_branch_name (branch_id, name)
    `);
    await queryRunner.query(`
      ALTER TABLE locations
      ADD active BOOLEAN NOT NULL DEFAULT TRUE AFTER code
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const inactiveRows = (await queryRunner.query(`
      SELECT
        (SELECT COUNT(*) FROM branches WHERE active = FALSE) +
        (SELECT COUNT(*) FROM warehouses WHERE active = FALSE) +
        (SELECT COUNT(*) FROM locations WHERE active = FALSE) AS total
    `)) as Array<{ total: number | string }>;
    if (Number(inactiveRows[0]?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert organization active state while inactive structures exist',
      );
    }
    await queryRunner.query('ALTER TABLE locations DROP COLUMN active');
    await queryRunner.query(`
      ALTER TABLE warehouses
      DROP KEY uq_warehouses_branch_name,
      DROP COLUMN active
    `);
    await queryRunner.query(`
      ALTER TABLE branches
      DROP KEY uq_branches_tenant_name,
      DROP COLUMN active
    `);
  }
}

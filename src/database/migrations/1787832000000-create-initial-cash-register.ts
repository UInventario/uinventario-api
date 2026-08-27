import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInitialCashRegister1787832000000 implements MigrationInterface {
  name = 'CreateInitialCashRegister1787832000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE cash_registers (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, branch_id CHAR(36) NOT NULL,
        name VARCHAR(120) NOT NULL, code VARCHAR(40) NOT NULL, onboarding_key VARCHAR(32) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_cash_registers_id_tenant (id, tenant_id),
        UNIQUE KEY uq_cash_registers_branch_code (branch_id, code),
        UNIQUE KEY uq_cash_registers_onboarding (tenant_id, onboarding_key),
        CONSTRAINT fk_cash_registers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_cash_registers_branch_tenant FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sessions
      ADD active_cash_register_id CHAR(36) NULL,
      ADD CONSTRAINT fk_sessions_active_cash_register_tenant FOREIGN KEY (active_cash_register_id, tenant_id) REFERENCES cash_registers(id, tenant_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sessions
      DROP FOREIGN KEY fk_sessions_active_cash_register_tenant,
      DROP COLUMN active_cash_register_id
    `);
    await queryRunner.query('DROP TABLE cash_registers');
  }
}

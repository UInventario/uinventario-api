import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInitialLocation1787828400000 implements MigrationInterface {
  name = 'CreateInitialLocation1787828400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE branches (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, name VARCHAR(120) NOT NULL,
        timezone VARCHAR(64) NOT NULL, onboarding_key VARCHAR(32) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_branches_id_tenant (id, tenant_id),
        UNIQUE KEY uq_branches_onboarding (tenant_id, onboarding_key),
        CONSTRAINT fk_branches_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE warehouses (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, branch_id CHAR(36) NOT NULL,
        name VARCHAR(120) NOT NULL, onboarding_key VARCHAR(32) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_warehouses_id_tenant (id, tenant_id),
        UNIQUE KEY uq_warehouses_onboarding (tenant_id, onboarding_key),
        CONSTRAINT fk_warehouses_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_warehouses_branch_tenant FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE locations (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, warehouse_id CHAR(36) NOT NULL,
        name VARCHAR(120) NOT NULL, code VARCHAR(40) NOT NULL, onboarding_key VARCHAR(32) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_locations_warehouse_code (warehouse_id, code),
        UNIQUE KEY uq_locations_onboarding (tenant_id, onboarding_key),
        CONSTRAINT fk_locations_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_locations_warehouse_tenant FOREIGN KEY (warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sessions
      ADD active_branch_id CHAR(36) NULL,
      ADD active_warehouse_id CHAR(36) NULL,
      ADD CONSTRAINT fk_sessions_active_branch_tenant FOREIGN KEY (active_branch_id, tenant_id) REFERENCES branches(id, tenant_id),
      ADD CONSTRAINT fk_sessions_active_warehouse_tenant FOREIGN KEY (active_warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sessions
      DROP FOREIGN KEY fk_sessions_active_warehouse_tenant,
      DROP FOREIGN KEY fk_sessions_active_branch_tenant,
      DROP COLUMN active_warehouse_id,
      DROP COLUMN active_branch_id
    `);
    await queryRunner.query('DROP TABLE locations');
    await queryRunner.query('DROP TABLE warehouses');
    await queryRunner.query('DROP TABLE branches');
  }
}

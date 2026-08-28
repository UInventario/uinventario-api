import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryReconciliation1788004800000 implements MigrationInterface {
  name = 'AddInventoryReconciliation1788004800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_reconciliation_runs (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        status ENUM('RUNNING', 'COMPLETED') NOT NULL,
        overall_status ENUM('HEALTHY', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'HEALTHY',
        finding_count INT UNSIGNED NOT NULL DEFAULT 0,
        warning_count INT UNSIGNED NOT NULL DEFAULT 0,
        critical_count INT UNSIGNED NOT NULL DEFAULT 0,
        operations_blocked BOOLEAN NOT NULL DEFAULT FALSE,
        correlation_id CHAR(36) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        finished_at DATETIME(6) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_reconciliation_runs_id_tenant (id, tenant_id),
        UNIQUE KEY uq_inventory_reconciliation_runs_tenant_idempotency
          (tenant_id, idempotency_key),
        KEY ix_inventory_reconciliation_runs_tenant_started
          (tenant_id, started_at, id),
        CONSTRAINT fk_inventory_reconciliation_runs_tenant
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_reconciliation_runs_user_tenant
          FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES users(id, tenant_id)
          ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_reconciliation_findings (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        run_id CHAR(36) NOT NULL,
        code VARCHAR(64) NOT NULL,
        severity ENUM('WARNING', 'CRITICAL') NOT NULL,
        scope_type ENUM('TENANT', 'PRODUCT', 'LOCATION', 'LOT', 'SERIAL', 'VALUATION') NOT NULL,
        product_id CHAR(36) NULL,
        location_id CHAR(36) NULL,
        subject_reference VARCHAR(160) NULL,
        expected_value DECIMAL(21,4) NULL,
        actual_value DECIMAL(21,4) NULL,
        difference_value DECIMAL(21,4) NULL,
        message VARCHAR(255) NOT NULL,
        recommended_action VARCHAR(255) NOT NULL,
        blocks_operations BOOLEAN NOT NULL DEFAULT FALSE,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY ix_inventory_reconciliation_findings_run (tenant_id, run_id, severity),
        KEY ix_inventory_reconciliation_findings_product
          (tenant_id, product_id, location_id),
        CONSTRAINT fk_inventory_reconciliation_findings_run_tenant
          FOREIGN KEY (run_id, tenant_id)
          REFERENCES inventory_reconciliation_runs(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_reconciliation_findings_product_tenant
          FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_reconciliation_findings_location_tenant
          FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_reconciliation_guards (
        tenant_id CHAR(36) NOT NULL,
        latest_run_id CHAR(36) NOT NULL,
        operations_blocked BOOLEAN NOT NULL,
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id),
        CONSTRAINT fk_inventory_reconciliation_guards_tenant
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_reconciliation_guards_run_tenant
          FOREIGN KEY (latest_run_id, tenant_id)
          REFERENCES inventory_reconciliation_runs(id, tenant_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE inventory_reconciliation_guards');
    await queryRunner.query('DROP TABLE inventory_reconciliation_findings');
    await queryRunner.query('DROP TABLE inventory_reconciliation_runs');
  }
}

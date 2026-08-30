import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSuspendedSales1788026400000 implements MigrationInterface {
  name = 'CreateSuspendedSales1788026400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE suspended_sales (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        warehouse_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NULL,
        completed_sale_id CHAR(36) NULL,
        notes VARCHAR(500) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        expires_at DATETIME(6) NOT NULL,
        cancelled_at DATETIME(6) NULL,
        resumed_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_suspended_sales_id_tenant (id, tenant_id),
        UNIQUE KEY uq_suspended_sales_idempotency (tenant_id, idempotency_key),
        UNIQUE KEY uq_suspended_sales_completed_sale (completed_sale_id),
        KEY ix_suspended_sales_owner_status (tenant_id, branch_id, cash_register_id, created_by_user_id, status, created_at),
        CONSTRAINT fk_suspended_sales_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_suspended_sales_branch_tenant FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_suspended_sales_warehouse_tenant FOREIGN KEY (warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_suspended_sales_cash_register_tenant FOREIGN KEY (cash_register_id, tenant_id) REFERENCES cash_registers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_suspended_sales_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_suspended_sales_customer_tenant FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_suspended_sales_completed_sale_tenant FOREIGN KEY (completed_sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_suspended_sales_status CHECK (status IN ('ACTIVE', 'CANCELLED', 'RESUMED', 'EXPIRED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE suspended_sale_lines (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        suspended_sale_id CHAR(36) NOT NULL,
        line_number INT NOT NULL,
        product_id CHAR(36) NOT NULL,
        product_name VARCHAR(160) NOT NULL,
        product_sku VARCHAR(40) NOT NULL,
        quantity DECIMAL(18,3) NOT NULL,
        lot_id CHAR(36) NULL,
        serial_numbers JSON NOT NULL,
        unit_price_snapshot DECIMAL(15,2) NOT NULL,
        available_quantity_snapshot DECIMAL(18,3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_suspended_sale_lines_number (suspended_sale_id, line_number),
        CONSTRAINT fk_suspended_sale_lines_sale_tenant FOREIGN KEY (suspended_sale_id, tenant_id) REFERENCES suspended_sales(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_suspended_sale_lines_product_tenant FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_suspended_sale_lines_quantity CHECK (quantity > 0 AND unit_price_snapshot >= 0 AND available_quantity_snapshot >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE suspended_sale_lines');
    await queryRunner.query('DROP TABLE suspended_sales');
  }
}

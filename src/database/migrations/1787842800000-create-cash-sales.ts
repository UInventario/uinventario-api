import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCashSales1787842800000 implements MigrationInterface {
  name = 'CreateCashSales1787842800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sales (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, branch_id CHAR(36) NOT NULL,
        warehouse_id CHAR(36) NOT NULL, cash_register_id CHAR(36) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL, receipt_number VARCHAR(24) NOT NULL,
        currency CHAR(3) NOT NULL, tax_rate DECIMAL(6,4) NOT NULL,
        subtotal DECIMAL(15,2) NOT NULL, tax_total DECIMAL(15,2) NOT NULL,
        total DECIMAL(15,2) NOT NULL, status VARCHAR(20) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_sales_tenant_receipt (tenant_id, receipt_number),
        UNIQUE KEY uq_sales_tenant_idempotency (tenant_id, idempotency_key),
        UNIQUE KEY uq_sales_id_tenant (id, tenant_id),
        CONSTRAINT fk_sales_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_branch_tenant FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_warehouse_tenant FOREIGN KEY (warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_cash_register_tenant FOREIGN KEY (cash_register_id, tenant_id) REFERENCES cash_registers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_sales_status CHECK (status IN ('COMPLETED')),
        CONSTRAINT ck_sales_totals CHECK (subtotal >= 0 AND tax_total >= 0 AND total > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE sale_lines (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, sale_id CHAR(36) NOT NULL,
        line_number INT NOT NULL, product_id CHAR(36) NOT NULL,
        product_name VARCHAR(160) NOT NULL, product_sku VARCHAR(40) NOT NULL,
        quantity DECIMAL(18,3) NOT NULL, unit_price DECIMAL(15,2) NOT NULL,
        subtotal DECIMAL(15,2) NOT NULL, tax DECIMAL(15,2) NOT NULL, total DECIMAL(15,2) NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY uq_sale_lines_number (sale_id, line_number),
        CONSTRAINT fk_sale_lines_sale_tenant FOREIGN KEY (sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_sale_lines_product_tenant FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_lines_amounts CHECK (quantity > 0 AND unit_price >= 0 AND subtotal >= 0 AND tax >= 0 AND total > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE sale_payments (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, sale_id CHAR(36) NOT NULL,
        method VARCHAR(20) NOT NULL, currency CHAR(3) NOT NULL,
        amount_received DECIMAL(15,2) NOT NULL, amount_applied DECIMAL(15,2) NOT NULL,
        change_amount DECIMAL(15,2) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_sale_payments_cash (sale_id, method),
        CONSTRAINT fk_sale_payments_sale_tenant FOREIGN KEY (sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_sale_payments_method CHECK (method IN ('CASH')),
        CONSTRAINT ck_sale_payments_amounts CHECK (amount_received >= amount_applied AND amount_applied > 0 AND change_amount >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE sale_payments');
    await queryRunner.query('DROP TABLE sale_lines');
    await queryRunner.query('DROP TABLE sales');
  }
}

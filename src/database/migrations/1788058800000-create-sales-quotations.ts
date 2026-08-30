import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSalesQuotations1788058800000 implements MigrationInterface {
  name = 'CreateSalesQuotations1788058800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sales_quotations (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL, warehouse_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL, customer_id CHAR(36) NULL,
        reservation_id CHAR(36) NULL, quotation_number VARCHAR(24) NOT NULL,
        channel VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL,
        currency CHAR(3) NOT NULL, tax_rate DECIMAL(6,4) NOT NULL,
        gross_total DECIMAL(18,2) NOT NULL, line_discount_total DECIMAL(18,2) NOT NULL,
        sale_discount_total DECIMAL(18,2) NOT NULL, discount_total DECIMAL(18,2) NOT NULL,
        discount_type VARCHAR(16) NULL, discount_value DECIMAL(18,2) NULL,
        discount_reason VARCHAR(240) NULL, subtotal DECIMAL(18,2) NOT NULL,
        tax_total DECIMAL(18,2) NOT NULL, total DECIMAL(18,2) NOT NULL,
        valid_until DATETIME(6) NOT NULL, notes VARCHAR(1000) NULL,
        version INT NOT NULL DEFAULT 1, idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL, created_by_user_id CHAR(36) NOT NULL,
        converted_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_sales_quotations_id_tenant (id, tenant_id),
        UNIQUE KEY uq_sales_quotations_number (tenant_id, quotation_number),
        UNIQUE KEY uq_sales_quotations_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_sales_quotations_reservation (tenant_id, reservation_id),
        KEY ix_sales_quotations_queue (tenant_id, branch_id, status, valid_until, created_at),
        CONSTRAINT fk_sales_quotations_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotations_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotations_warehouse FOREIGN KEY (warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotations_register FOREIGN KEY (cash_register_id, tenant_id) REFERENCES cash_registers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotations_customer FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotations_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES product_reservations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotations_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_sales_quotations_channel CHECK (channel IN ('POS', 'WEB', 'MOBILE', 'DESKTOP')),
        CONSTRAINT ck_sales_quotations_status CHECK (status IN ('ACTIVE', 'EXPIRED', 'CONVERTING', 'CONVERTED')),
        CONSTRAINT ck_sales_quotations_amounts CHECK (gross_total >= 0 AND subtotal >= 0 AND tax_total >= 0 AND total > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE sales_quotation_lines (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, quotation_id CHAR(36) NOT NULL,
        line_number INT NOT NULL, product_id CHAR(36) NOT NULL, lot_id CHAR(36) NULL,
        quantity DECIMAL(18,3) NOT NULL, serial_numbers JSON NOT NULL,
        product_name VARCHAR(160) NOT NULL, product_sku VARCHAR(40) NOT NULL,
        available_quantity DECIMAL(18,3) NOT NULL, unit_price DECIMAL(18,2) NOT NULL,
        price_source VARCHAR(16) NOT NULL, price_list_id CHAR(36) NULL,
        price_list_name VARCHAR(120) NULL, gross_total DECIMAL(18,2) NOT NULL,
        line_discount_total DECIMAL(18,2) NOT NULL, sale_discount_total DECIMAL(18,2) NOT NULL,
        discount_total DECIMAL(18,2) NOT NULL, discount_type VARCHAR(16) NULL,
        discount_value DECIMAL(18,2) NULL, discount_reason VARCHAR(240) NULL,
        subtotal DECIMAL(18,2) NOT NULL, tax DECIMAL(18,2) NOT NULL, total DECIMAL(18,2) NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY uq_sales_quotation_lines_id_tenant (id, tenant_id),
        UNIQUE KEY uq_sales_quotation_lines_number (quotation_id, line_number),
        CONSTRAINT fk_sales_quotation_lines_quote FOREIGN KEY (quotation_id, tenant_id) REFERENCES sales_quotations(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_sales_quotation_lines_product FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotation_lines_lot FOREIGN KEY (lot_id, tenant_id) REFERENCES inventory_lots(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sales_quotation_lines_price_list FOREIGN KEY (price_list_id, tenant_id) REFERENCES price_lists(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sales_quotation_lines_quantity CHECK (quantity > 0),
        CONSTRAINT ck_sales_quotation_lines_price_source CHECK (price_source IN ('BASE', 'PRICE_LIST'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE sales_quotation_operations (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, quotation_id CHAR(36) NOT NULL,
        action VARCHAR(16) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_sales_quotation_operations_key (tenant_id, idempotency_key),
        KEY ix_sales_quotation_operations_quote (tenant_id, quotation_id, created_at),
        CONSTRAINT fk_sales_quotation_operations_quote FOREIGN KEY (quotation_id, tenant_id) REFERENCES sales_quotations(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_sales_quotation_operations_action CHECK (action IN ('UPDATE', 'CONVERT'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sales ADD COLUMN quotation_id CHAR(36) NULL AFTER reservation_id,
        ADD UNIQUE KEY uq_sales_quotation (tenant_id, quotation_id),
        ADD CONSTRAINT fk_sales_quotation FOREIGN KEY (quotation_id, tenant_id)
          REFERENCES sales_quotations(id, tenant_id) ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE sales DROP FOREIGN KEY fk_sales_quotation, DROP KEY uq_sales_quotation, DROP COLUMN quotation_id',
    );
    await queryRunner.query('DROP TABLE sales_quotation_operations');
    await queryRunner.query('DROP TABLE sales_quotation_lines');
    await queryRunner.query('DROP TABLE sales_quotations');
  }
}

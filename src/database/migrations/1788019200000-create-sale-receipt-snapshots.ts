import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSaleReceiptSnapshots1788019200000 implements MigrationInterface {
  name = 'CreateSaleReceiptSnapshots1788019200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sale_receipt_snapshots (
        sale_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        receipt_number VARCHAR(24) NOT NULL,
        merchant_name VARCHAR(160) NOT NULL,
        merchant_legal_name VARCHAR(160) NULL,
        country_code CHAR(2) NULL,
        branch_name VARCHAR(120) NOT NULL,
        cash_register_name VARCHAR(120) NOT NULL,
        cash_register_code VARCHAR(40) NOT NULL,
        seller_email VARCHAR(254) NOT NULL,
        customer_name VARCHAR(160) NULL,
        customer_identifier VARCHAR(80) NULL,
        currency CHAR(3) NOT NULL,
        tax_rate DECIMAL(6,4) NOT NULL,
        subtotal DECIMAL(15,2) NOT NULL,
        tax_total DECIMAL(15,2) NOT NULL,
        total DECIMAL(15,2) NOT NULL,
        receipt_lines JSON NOT NULL,
        receipt_payments JSON NOT NULL,
        issued_at DATETIME(6) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (sale_id),
        UNIQUE KEY uq_sale_receipt_tenant_number (tenant_id, receipt_number),
        CONSTRAINT fk_sale_receipt_sale_tenant
          FOREIGN KEY (sale_id, tenant_id)
          REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_receipt_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_receipt_totals
          CHECK (subtotal >= 0 AND tax_total >= 0 AND total > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO sale_receipt_snapshots
        (sale_id, tenant_id, receipt_number, merchant_name, merchant_legal_name,
         country_code, branch_name, cash_register_name, cash_register_code,
         seller_email, customer_name, customer_identifier, currency, tax_rate,
         subtotal, tax_total, total, receipt_lines, receipt_payments, issued_at)
      SELECT sale.id, sale.tenant_id, sale.receipt_number, tenant.name,
             tenant.legal_name, tenant.country_code, branch.name,
             register.name, register.code, seller.email, customer.name,
             customer.identifier, sale.currency, sale.tax_rate, sale.subtotal,
             sale.tax_total, sale.total,
             COALESCE((
               SELECT JSON_ARRAYAGG(JSON_OBJECT(
                 'lineNumber', line.line_number,
                 'productName', line.product_name,
                 'productSku', line.product_sku,
                 'quantity', line.quantity,
                 'unitPrice', line.unit_price,
                 'subtotal', line.subtotal,
                 'tax', line.tax,
                 'total', line.total
               )) FROM sale_lines line
               WHERE line.sale_id = sale.id AND line.tenant_id = sale.tenant_id
             ), JSON_ARRAY()),
             COALESCE((
               SELECT JSON_ARRAYAGG(JSON_OBJECT(
                 'method', payment.method,
                 'amountReceived', payment.amount_received,
                 'amountApplied', payment.amount_applied,
                 'change', payment.change_amount,
                 'reference', payment.external_reference,
                 'provider', payment.provider,
                 'authorizationCode', payment.authorization_code
               )) FROM sale_payments payment
               WHERE payment.sale_id = sale.id AND payment.tenant_id = sale.tenant_id
             ), JSON_ARRAY()),
             sale.created_at
      FROM sales sale
      INNER JOIN tenants tenant ON tenant.id = sale.tenant_id
      INNER JOIN branches branch
        ON branch.id = sale.branch_id AND branch.tenant_id = sale.tenant_id
      INNER JOIN cash_registers register
        ON register.id = sale.cash_register_id AND register.tenant_id = sale.tenant_id
      INNER JOIN users seller
        ON seller.id = sale.created_by_user_id AND seller.tenant_id = sale.tenant_id
      LEFT JOIN customers customer
        ON customer.id = sale.customer_id AND customer.tenant_id = sale.tenant_id
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE sale_receipt_snapshots');
  }
}

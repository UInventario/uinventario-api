import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSaleDiscounts1788044400000 implements MigrationInterface {
  name = 'AddSaleDiscounts1788044400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sales
      ADD COLUMN gross_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER tax_rate,
      ADD COLUMN line_discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER gross_total,
      ADD COLUMN sale_discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER line_discount_total,
      ADD COLUMN discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER sale_discount_total,
      ADD COLUMN discount_type VARCHAR(20) NULL AFTER discount_total,
      ADD COLUMN discount_value DECIMAL(15,2) NULL AFTER discount_type,
      ADD COLUMN discount_reason VARCHAR(240) NULL AFTER discount_value
    `);
    await queryRunner.query('UPDATE sales SET gross_total = total');
    await queryRunner.query(`
      ALTER TABLE sales
      ADD CONSTRAINT ck_sales_discount_amounts CHECK (
        gross_total > 0 AND line_discount_total >= 0 AND sale_discount_total >= 0
        AND discount_total = line_discount_total + sale_discount_total
        AND discount_total < gross_total AND total = gross_total - discount_total
        AND discount_total * 2 <= gross_total
      ),
      ADD CONSTRAINT ck_sales_discount_metadata CHECK (
        (discount_type IS NULL AND discount_value IS NULL AND discount_reason IS NULL
          AND sale_discount_total = 0)
        OR (discount_type IN ('PERCENT', 'AMOUNT') AND discount_value > 0
          AND CHAR_LENGTH(TRIM(discount_reason)) >= 3 AND sale_discount_total > 0)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      ADD COLUMN gross_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER price_list_name,
      ADD COLUMN line_discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER gross_total,
      ADD COLUMN sale_discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER line_discount_total,
      ADD COLUMN discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER sale_discount_total,
      ADD COLUMN discount_type VARCHAR(20) NULL AFTER discount_total,
      ADD COLUMN discount_value DECIMAL(15,2) NULL AFTER discount_type,
      ADD COLUMN discount_reason VARCHAR(240) NULL AFTER discount_value
    `);
    await queryRunner.query('UPDATE sale_lines SET gross_total = total');
    await queryRunner.query(`
      ALTER TABLE sale_lines
      ADD CONSTRAINT ck_sale_lines_discount_amounts CHECK (
        gross_total > 0 AND line_discount_total >= 0 AND sale_discount_total >= 0
        AND discount_total = line_discount_total + sale_discount_total
        AND discount_total < gross_total AND total = gross_total - discount_total
      ),
      ADD CONSTRAINT ck_sale_lines_discount_metadata CHECK (
        (discount_type IS NULL AND discount_value IS NULL AND discount_reason IS NULL
          AND line_discount_total = 0)
        OR (discount_type IN ('PERCENT', 'AMOUNT') AND discount_value > 0
          AND CHAR_LENGTH(TRIM(discount_reason)) >= 3 AND line_discount_total > 0)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sale_lines
      DROP CHECK ck_sale_lines_discount_metadata,
      DROP CHECK ck_sale_lines_discount_amounts,
      DROP COLUMN discount_reason,
      DROP COLUMN discount_value,
      DROP COLUMN discount_type,
      DROP COLUMN discount_total,
      DROP COLUMN sale_discount_total,
      DROP COLUMN line_discount_total,
      DROP COLUMN gross_total
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      DROP CHECK ck_sales_discount_metadata,
      DROP CHECK ck_sales_discount_amounts,
      DROP COLUMN discount_reason,
      DROP COLUMN discount_value,
      DROP COLUMN discount_type,
      DROP COLUMN discount_total,
      DROP COLUMN sale_discount_total,
      DROP COLUMN line_discount_total,
      DROP COLUMN gross_total
    `);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePromotions1788087600000 implements MigrationInterface {
  name = 'CreatePromotions1788087600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE promotions (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        name VARCHAR(120) NOT NULL,
        type ENUM('BUY_X_GET_Y','SECOND_UNIT_PERCENT','BUNDLE_FIXED','QUANTITY_PERCENT') NOT NULL,
        branch_id CHAR(36) NULL, customer_id CHAR(36) NULL,
        channel ENUM('POS','WEB','MOBILE','DESKTOP') NULL,
        priority INT NOT NULL DEFAULT 0, stackable BOOLEAN NOT NULL DEFAULT FALSE,
        valid_from DATETIME(6) NOT NULL, valid_to DATETIME(6) NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        discount_percent DECIMAL(7,4) NULL, fixed_price DECIMAL(15,2) NULL,
        buy_quantity DECIMAL(15,3) NULL, reward_quantity DECIMAL(15,3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_promotions_id_tenant (id, tenant_id),
        KEY ix_promotions_resolution (tenant_id, active, priority, valid_from, valid_to),
        CONSTRAINT fk_promotions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_promotions_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_promotions_customer FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_promotions_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
        CONSTRAINT ck_promotions_values CHECK (
          (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100))
          AND (fixed_price IS NULL OR fixed_price > 0)
          AND (buy_quantity IS NULL OR buy_quantity > 0)
          AND (reward_quantity IS NULL OR reward_quantity > 0)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE promotion_products (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        promotion_id CHAR(36) NOT NULL, product_id CHAR(36) NOT NULL,
        quantity DECIMAL(15,3) NOT NULL DEFAULT 1, position SMALLINT UNSIGNED NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_promotion_products_product (tenant_id, promotion_id, product_id),
        CONSTRAINT fk_promotion_products_promotion FOREIGN KEY (promotion_id, tenant_id) REFERENCES promotions(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_promotion_products_product FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_promotion_product_quantity CHECK (quantity > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE promotion_quantity_tiers (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        promotion_id CHAR(36) NOT NULL, minimum_quantity DECIMAL(15,3) NOT NULL,
        discount_percent DECIMAL(7,4) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_promotion_tier_minimum (tenant_id, promotion_id, minimum_quantity),
        CONSTRAINT fk_promotion_tiers_promotion FOREIGN KEY (promotion_id, tenant_id) REFERENCES promotions(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_promotion_tier_values CHECK (minimum_quantity > 0 AND discount_percent > 0 AND discount_percent < 100)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sales_quotations
      ADD COLUMN promotion_discount_total DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER line_discount_total
    `);
    await queryRunner.query(`
      ALTER TABLE sales_quotation_lines
      ADD COLUMN promotion_discount_total DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER line_discount_total,
      ADD COLUMN promotions_snapshot JSON NULL AFTER discount_reason
    `);
    await queryRunner.query(
      `UPDATE sales_quotation_lines SET promotions_snapshot = JSON_ARRAY() WHERE promotions_snapshot IS NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE sales
      DROP CHECK ck_sales_discount_amounts,
      ADD COLUMN promotion_discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER line_discount_total,
      ADD CONSTRAINT ck_sales_discount_amounts CHECK (
        gross_total > 0 AND line_discount_total >= 0 AND promotion_discount_total >= 0
        AND sale_discount_total >= 0
        AND discount_total = line_discount_total + promotion_discount_total + sale_discount_total
        AND discount_total < gross_total AND total = gross_total - discount_total
        AND discount_total * 2 <= gross_total
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      DROP CHECK ck_sale_lines_discount_amounts,
      ADD COLUMN promotion_discount_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER line_discount_total,
      ADD CONSTRAINT ck_sale_lines_discount_amounts CHECK (
        gross_total > 0 AND line_discount_total >= 0 AND promotion_discount_total >= 0
        AND sale_discount_total >= 0
        AND discount_total = line_discount_total + promotion_discount_total + sale_discount_total
        AND discount_total < gross_total AND total = gross_total - discount_total
      )
    `);
    await queryRunner.query(`
      CREATE TABLE sale_line_promotions (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        sale_id CHAR(36) NOT NULL, sale_line_id CHAR(36) NOT NULL,
        promotion_id CHAR(36) NOT NULL, promotion_name VARCHAR(120) NOT NULL,
        promotion_type VARCHAR(32) NOT NULL, priority INT NOT NULL,
        discount_amount DECIMAL(15,2) NOT NULL, explanation VARCHAR(500) NOT NULL,
        rule_snapshot JSON NOT NULL,
        PRIMARY KEY (id), KEY ix_sale_line_promotions_sale (tenant_id, sale_id),
        CONSTRAINT fk_sale_line_promotions_sale FOREIGN KEY (sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_line_promotions_line FOREIGN KEY (sale_line_id, tenant_id) REFERENCES sale_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_line_promotions_promotion FOREIGN KEY (promotion_id, tenant_id) REFERENCES promotions(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_line_promotion_amount CHECK (discount_amount > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE sale_line_promotions');
    await queryRunner.query(`ALTER TABLE sale_lines DROP CHECK ck_sale_lines_discount_amounts,
      DROP COLUMN promotion_discount_total,
      ADD CONSTRAINT ck_sale_lines_discount_amounts CHECK (
        gross_total > 0 AND line_discount_total >= 0 AND sale_discount_total >= 0
        AND discount_total = line_discount_total + sale_discount_total
        AND discount_total < gross_total AND total = gross_total - discount_total)`);
    await queryRunner.query(`ALTER TABLE sales DROP CHECK ck_sales_discount_amounts,
      DROP COLUMN promotion_discount_total,
      ADD CONSTRAINT ck_sales_discount_amounts CHECK (
        gross_total > 0 AND line_discount_total >= 0 AND sale_discount_total >= 0
        AND discount_total = line_discount_total + sale_discount_total
        AND discount_total < gross_total AND total = gross_total - discount_total
        AND discount_total * 2 <= gross_total)`);
    await queryRunner.query(
      'ALTER TABLE sales_quotation_lines DROP COLUMN promotions_snapshot, DROP COLUMN promotion_discount_total',
    );
    await queryRunner.query(
      'ALTER TABLE sales_quotations DROP COLUMN promotion_discount_total',
    );
    await queryRunner.query('DROP TABLE promotion_quantity_tiers');
    await queryRunner.query('DROP TABLE promotion_products');
    await queryRunner.query('DROP TABLE promotions');
  }
}

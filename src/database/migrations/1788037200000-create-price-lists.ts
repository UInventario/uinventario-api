import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePriceLists1788037200000 implements MigrationInterface {
  name = 'CreatePriceLists1788037200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE price_lists (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        name VARCHAR(120) NOT NULL, currency CHAR(3) NOT NULL,
        branch_id CHAR(36) NULL, customer_id CHAR(36) NULL,
        channel VARCHAR(20) NULL, priority INT NOT NULL DEFAULT 0,
        valid_from DATETIME(6) NOT NULL, valid_to DATETIME(6) NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE, version INT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_price_lists_id_tenant (id, tenant_id),
        KEY ix_price_lists_resolution (tenant_id, currency, active, priority, valid_from, valid_to),
        KEY ix_price_lists_branch (tenant_id, branch_id),
        KEY ix_price_lists_customer (tenant_id, customer_id),
        CONSTRAINT fk_price_lists_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_price_lists_branch_tenant FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_price_lists_customer_tenant FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_price_lists_values CHECK (
          CHAR_LENGTH(name) BETWEEN 2 AND 120 AND currency REGEXP '^[A-Z]{3}$'
          AND (channel IS NULL OR channel IN ('POS', 'WEB', 'MOBILE', 'DESKTOP'))
          AND priority BETWEEN -100000 AND 100000
          AND (valid_to IS NULL OR valid_to > valid_from) AND version > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE price_list_items (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        price_list_id CHAR(36) NOT NULL, product_id CHAR(36) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_price_list_items_product (tenant_id, price_list_id, product_id),
        KEY ix_price_list_items_resolution (tenant_id, product_id, price_list_id),
        CONSTRAINT fk_price_list_items_list_tenant FOREIGN KEY (price_list_id, tenant_id) REFERENCES price_lists(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_price_list_items_product_tenant FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_price_list_items_price CHECK (price > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sale_lines
      ADD COLUMN price_source VARCHAR(20) NOT NULL DEFAULT 'BASE' AFTER unit_price,
      ADD COLUMN price_list_id CHAR(36) NULL AFTER price_source,
      ADD COLUMN price_list_name VARCHAR(120) NULL AFTER price_list_id,
      ADD KEY ix_sale_lines_price_list (price_list_id, tenant_id),
      ADD CONSTRAINT fk_sale_lines_price_list_tenant FOREIGN KEY (price_list_id, tenant_id) REFERENCES price_lists(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_sale_lines_price_source CHECK (
        (price_source = 'BASE' AND price_list_id IS NULL AND price_list_name IS NULL)
        OR (price_source = 'PRICE_LIST' AND price_list_id IS NOT NULL AND price_list_name IS NOT NULL))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sale_lines
      DROP FOREIGN KEY fk_sale_lines_price_list_tenant,
      DROP CHECK ck_sale_lines_price_source,
      DROP INDEX ix_sale_lines_price_list,
      DROP COLUMN price_list_name, DROP COLUMN price_list_id, DROP COLUMN price_source`);
    await queryRunner.query('DROP TABLE price_list_items');
    await queryRunner.query('DROP TABLE price_lists');
  }
}

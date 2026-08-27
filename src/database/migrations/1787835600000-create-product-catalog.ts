import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductCatalog1787835600000 implements MigrationInterface {
  name = 'CreateProductCatalog1787835600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE categories (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, name VARCHAR(80) NOT NULL,
        normalized_name VARCHAR(80) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_categories_id_tenant (id, tenant_id),
        UNIQUE KEY uq_categories_tenant_name (tenant_id, normalized_name),
        CONSTRAINT fk_categories_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE brands (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, name VARCHAR(120) NOT NULL,
        normalized_name VARCHAR(120) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_brands_id_tenant (id, tenant_id),
        UNIQUE KEY uq_brands_tenant_name (tenant_id, normalized_name),
        CONSTRAINT fk_brands_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE products (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, name VARCHAR(160) NOT NULL,
        sku VARCHAR(40) NOT NULL, normalized_sku VARCHAR(40) NOT NULL, barcode VARCHAR(64) NULL,
        category_id CHAR(36) NULL, brand_id CHAR(36) NULL,
        cost DECIMAL(15,2) NOT NULL, price DECIMAL(15,2) NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_products_id_tenant (id, tenant_id),
        UNIQUE KEY uq_products_tenant_sku (tenant_id, normalized_sku),
        UNIQUE KEY uq_products_tenant_barcode (tenant_id, barcode),
        CONSTRAINT fk_products_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_products_category_tenant FOREIGN KEY (category_id, tenant_id) REFERENCES categories(id, tenant_id),
        CONSTRAINT fk_products_brand_tenant FOREIGN KEY (brand_id, tenant_id) REFERENCES brands(id, tenant_id),
        CONSTRAINT ck_products_cost_nonnegative CHECK (cost >= 0),
        CONSTRAINT ck_products_price_nonnegative CHECK (price >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE products');
    await queryRunner.query('DROP TABLE brands');
    await queryRunner.query('DROP TABLE categories');
  }
}

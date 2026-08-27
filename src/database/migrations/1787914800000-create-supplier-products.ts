import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSupplierProducts1787914800000 implements MigrationInterface {
  name = 'CreateSupplierProducts1787914800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE supplier_products (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        supplier_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        supplier_code VARCHAR(64) NOT NULL,
        normalized_supplier_code VARCHAR(64) NOT NULL,
        minimum_quantity DECIMAL(15,3) NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_supplier_products_id_tenant (id, tenant_id),
        UNIQUE KEY uq_supplier_products_supplier_product (tenant_id, supplier_id, product_id),
        UNIQUE KEY uq_supplier_products_supplier_code (tenant_id, supplier_id, normalized_supplier_code),
        KEY ix_supplier_products_product (tenant_id, product_id, active),
        CONSTRAINT fk_supplier_products_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_supplier_products_supplier FOREIGN KEY (supplier_id, tenant_id)
          REFERENCES suppliers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_supplier_products_product FOREIGN KEY (product_id, tenant_id)
          REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_supplier_products_minimum CHECK (
          minimum_quantity IS NULL OR minimum_quantity > 0
        ),
        CONSTRAINT ck_supplier_products_version CHECK (version > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE supplier_product_prices (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        supplier_product_id CHAR(36) NOT NULL,
        currency CHAR(3) NOT NULL,
        unit_cost DECIMAL(15,2) NOT NULL,
        valid_from DATE NOT NULL,
        valid_to DATE NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_supplier_product_prices_date (tenant_id, supplier_product_id, valid_from),
        KEY ix_supplier_product_prices_history (tenant_id, supplier_product_id, valid_from, id),
        CONSTRAINT fk_supplier_product_prices_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_supplier_product_prices_link FOREIGN KEY (supplier_product_id, tenant_id)
          REFERENCES supplier_products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_supplier_product_prices_user FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_supplier_product_prices_cost CHECK (unit_cost > 0),
        CONSTRAINT ck_supplier_product_prices_dates CHECK (
          valid_to IS NULL OR valid_to >= valid_from
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE supplier_product_prices');
    await queryRunner.query('DROP TABLE supplier_products');
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductKits1788084000000 implements MigrationInterface {
  name = 'CreateProductKits1788084000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE product_kits (
        product_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        stock_mode ENUM('DERIVED','ASSEMBLED') NOT NULL,
        price_rule ENUM('FIXED','COMPONENT_SUM') NOT NULL,
        effective_from DATE NULL,
        effective_to DATE NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (product_id),
        UNIQUE KEY uq_product_kits_product_tenant (product_id, tenant_id),
        KEY ix_product_kits_tenant (tenant_id, product_id),
        CONSTRAINT fk_product_kits_product_tenant
          FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_product_kits_validity CHECK (
          effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE product_kit_components (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        kit_product_id CHAR(36) NOT NULL,
        component_product_id CHAR(36) NOT NULL,
        quantity DECIMAL(15,3) NOT NULL,
        position SMALLINT UNSIGNED NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_kit_component (tenant_id, kit_product_id, component_product_id),
        KEY ix_kit_components_component (tenant_id, component_product_id),
        CONSTRAINT fk_kit_components_kit_tenant
          FOREIGN KEY (kit_product_id, tenant_id) REFERENCES product_kits(product_id, tenant_id)
          ON DELETE CASCADE,
        CONSTRAINT fk_kit_components_product_tenant
          FOREIGN KEY (component_product_id, tenant_id) REFERENCES products(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT ck_kit_component_quantity CHECK (quantity > 0),
        CONSTRAINT ck_kit_component_not_self CHECK (kit_product_id <> component_product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE kit_inventory_operations (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        kit_product_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        operation_type ENUM('ASSEMBLE','DISASSEMBLE') NOT NULL,
        quantity DECIMAL(15,3) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_kit_operations_idempotency (tenant_id, idempotency_key),
        KEY ix_kit_operations_product (tenant_id, kit_product_id, created_at),
        CONSTRAINT fk_kit_operations_product_tenant
          FOREIGN KEY (kit_product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_kit_operations_location_tenant
          FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_kit_operations_user_tenant
          FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_kit_operation_quantity CHECK (quantity > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE sale_kit_components (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        sale_id CHAR(36) NOT NULL,
        sale_line_id CHAR(36) NOT NULL,
        kit_product_id CHAR(36) NOT NULL,
        component_product_id CHAR(36) NOT NULL,
        component_name VARCHAR(120) NOT NULL,
        component_sku VARCHAR(40) NOT NULL,
        quantity_per_kit DECIMAL(15,3) NOT NULL,
        total_quantity DECIMAL(15,3) NOT NULL,
        unit_cost DECIMAL(15,4) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sale_kit_component (tenant_id, sale_line_id, component_product_id),
        KEY ix_sale_kit_components_sale (tenant_id, sale_id),
        CONSTRAINT fk_sale_kit_components_sale_tenant
          FOREIGN KEY (sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_kit_components_line_tenant
          FOREIGN KEY (sale_line_id, tenant_id) REFERENCES sale_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_kit_components_kit_tenant
          FOREIGN KEY (kit_product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_sale_kit_components_product_tenant
          FOREIGN KEY (component_product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_sale_kit_component_quantities CHECK (
          quantity_per_kit > 0 AND total_quantity > 0
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE sale_kit_components');
    await queryRunner.query('DROP TABLE kit_inventory_operations');
    await queryRunner.query('DROP TABLE product_kit_components');
    await queryRunner.query('DROP TABLE product_kits');
  }
}

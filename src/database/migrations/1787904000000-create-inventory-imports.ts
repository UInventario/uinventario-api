import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryImports1787904000000 implements MigrationInterface {
  name = 'CreateInventoryImports1787904000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_imports (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        warehouse_id CHAR(36) NOT NULL,
        mode VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PREVIEWED',
        processing_policy VARCHAR(20) NOT NULL DEFAULT 'ATOMIC',
        source_filename VARCHAR(160) NOT NULL,
        source_hash CHAR(64) NOT NULL,
        row_count INT UNSIGNED NOT NULL,
        valid_row_count INT UNSIGNED NOT NULL,
        error_row_count INT UNSIGNED NOT NULL,
        movement_count INT UNSIGNED NULL,
        created_by_user_id CHAR(36) NOT NULL,
        confirmed_by_user_id CHAR(36) NULL,
        confirmation_idempotency_key VARCHAR(128) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        confirmed_at DATETIME(6) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_imports_id_tenant (id, tenant_id),
        UNIQUE KEY uq_inventory_imports_confirmation_key
          (tenant_id, confirmation_idempotency_key),
        KEY ix_inventory_imports_tenant_created (tenant_id, created_at, id),
        CONSTRAINT fk_inventory_imports_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_imports_warehouse_tenant
          FOREIGN KEY (warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_imports_created_by FOREIGN KEY (created_by_user_id)
          REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_imports_confirmed_by FOREIGN KEY (confirmed_by_user_id)
          REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_imports_mode CHECK (mode IN ('INITIAL', 'COUNT')),
        CONSTRAINT ck_inventory_imports_status CHECK (status IN ('PREVIEWED', 'CONFIRMED')),
        CONSTRAINT ck_inventory_imports_policy CHECK (processing_policy = 'ATOMIC'),
        CONSTRAINT ck_inventory_imports_confirmation CHECK (
          (status = 'PREVIEWED' AND movement_count IS NULL
            AND confirmed_by_user_id IS NULL AND confirmation_idempotency_key IS NULL
            AND confirmed_at IS NULL)
          OR
          (status = 'CONFIRMED' AND movement_count IS NOT NULL
            AND confirmed_by_user_id IS NOT NULL AND confirmation_idempotency_key IS NOT NULL
            AND confirmed_at IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_import_rows (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        import_id CHAR(36) NOT NULL,
        source_row INT UNSIGNED NOT NULL,
        product_id CHAR(36) NULL,
        location_id CHAR(36) NULL,
        product_sku VARCHAR(40) NOT NULL,
        location_code VARCHAR(40) NOT NULL,
        stock_state VARCHAR(20) NULL,
        target_quantity DECIMAL(18,3) NULL,
        preview_quantity DECIMAL(18,3) NULL,
        preview_difference DECIMAL(18,3) NULL,
        reason VARCHAR(160) NOT NULL,
        errors JSON NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_import_rows_id_tenant (id, tenant_id),
        UNIQUE KEY uq_inventory_import_rows_number (import_id, source_row),
        KEY ix_inventory_import_rows_target (tenant_id, product_id, location_id),
        CONSTRAINT fk_inventory_import_rows_import_tenant
          FOREIGN KEY (import_id, tenant_id) REFERENCES inventory_imports(id, tenant_id)
          ON DELETE CASCADE,
        CONSTRAINT fk_inventory_import_rows_product_tenant
          FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_import_rows_location_tenant
          FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_import_rows_state CHECK (
          stock_state IS NULL OR stock_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      ADD inventory_import_id CHAR(36) NULL AFTER receipt_id,
      ADD inventory_import_row_id CHAR(36) NULL AFTER inventory_import_id,
      ADD KEY ix_inventory_movements_import (tenant_id, inventory_import_id),
      ADD CONSTRAINT fk_inventory_movements_import_tenant
        FOREIGN KEY (inventory_import_id, tenant_id)
        REFERENCES inventory_imports(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_import_row_tenant
        FOREIGN KEY (inventory_import_row_id, tenant_id)
        REFERENCES inventory_import_rows(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'IMPORT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY')
      ),
      ADD CONSTRAINT ck_inventory_movements_import_link CHECK (
        (type = 'IMPORT' AND inventory_import_id IS NOT NULL
          AND inventory_import_row_id IS NOT NULL)
        OR
        (type <> 'IMPORT' AND inventory_import_id IS NULL
          AND inventory_import_row_id IS NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [summary] = (await queryRunner.query(
      "SELECT COUNT(*) AS total FROM inventory_movements WHERE type = 'IMPORT'",
    )) as Array<{ total: number | string }>;
    if (Number(summary?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert inventory imports while import movement history exists',
      );
    }
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_import_link,
      DROP CHECK ck_inventory_movements_type,
      DROP FOREIGN KEY fk_inventory_movements_import_row_tenant,
      DROP FOREIGN KEY fk_inventory_movements_import_tenant,
      DROP KEY ix_inventory_movements_import,
      DROP COLUMN inventory_import_row_id,
      DROP COLUMN inventory_import_id,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY')
      )
    `);
    await queryRunner.query('DROP TABLE inventory_import_rows');
    await queryRunner.query('DROP TABLE inventory_imports');
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFifoInventoryValuation1787994000000 implements MigrationInterface {
  name = 'AddFifoInventoryValuation1787994000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_fifo_cutovers (
        tenant_id CHAR(36) NOT NULL,
        effective_at DATETIME(6) NOT NULL,
        migration_rule ENUM('OPENING_BALANCE_AT_MOVING_AVERAGE') NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id),
        CONSTRAINT fk_inventory_fifo_cutovers_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_fifo_layers (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        source_movement_id CHAR(36) NULL,
        source_layer_id CHAR(36) NULL,
        purchase_receipt_line_id CHAR(36) NULL,
        origin_type ENUM('MIGRATION_CUT', 'ENTRY', 'PURCHASE_RECEIPT', 'RETURN', 'TRANSFER') NOT NULL,
        original_quantity DECIMAL(18,3) NOT NULL,
        remaining_quantity DECIMAL(18,3) NOT NULL,
        unit_cost DECIMAL(15,4) NOT NULL,
        currency CHAR(3) NOT NULL,
        acquired_at DATETIME(6) NOT NULL,
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_fifo_layers_id_tenant (id, tenant_id),
        KEY ix_inventory_fifo_layers_consumption
          (tenant_id, product_id, location_id, acquired_at, id),
        KEY ix_inventory_fifo_layers_receipt
          (tenant_id, purchase_receipt_line_id, location_id),
        CONSTRAINT fk_inventory_fifo_layers_product_tenant
          FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_fifo_layers_location_tenant
          FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_fifo_layers_source_movement
          FOREIGN KEY (source_movement_id) REFERENCES inventory_movements(id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_fifo_layers_source_layer_tenant
          FOREIGN KEY (source_layer_id, tenant_id)
          REFERENCES inventory_fifo_layers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_fifo_layers_receipt_line_tenant
          FOREIGN KEY (purchase_receipt_line_id, tenant_id)
          REFERENCES purchase_receipt_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_fifo_layers_original_quantity
          CHECK (original_quantity > 0),
        CONSTRAINT ck_inventory_fifo_layers_remaining_quantity
          CHECK (remaining_quantity >= 0 AND remaining_quantity <= original_quantity),
        CONSTRAINT ck_inventory_fifo_layers_cost CHECK (unit_cost >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_movement_fifo_layers (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        movement_id CHAR(36) NOT NULL,
        layer_id CHAR(36) NOT NULL,
        source_allocation_id CHAR(36) NULL,
        quantity_change DECIMAL(18,3) NOT NULL,
        unit_cost DECIMAL(15,4) NOT NULL,
        currency CHAR(3) NOT NULL,
        value_change DECIMAL(21,4) NOT NULL,
        selection_mode ENUM('ENTRY', 'FIFO', 'RESTORE', 'TRANSFER', 'ORIGIN_RETURN') NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_movement_fifo_layer
          (tenant_id, movement_id, layer_id),
        KEY ix_inventory_movement_fifo_layers_layer
          (tenant_id, layer_id, created_at, id),
        CONSTRAINT fk_inventory_movement_fifo_layers_movement
          FOREIGN KEY (movement_id) REFERENCES inventory_movements(id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_movement_fifo_layers_layer_tenant
          FOREIGN KEY (layer_id, tenant_id)
          REFERENCES inventory_fifo_layers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_movement_fifo_layers_source_allocation
          FOREIGN KEY (source_allocation_id)
          REFERENCES inventory_movement_fifo_layers(id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_movement_fifo_layers_quantity
          CHECK (quantity_change <> 0),
        CONSTRAINT ck_inventory_movement_fifo_layers_cost CHECK (unit_cost >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      ADD fifo_unit_cost DECIMAL(15,4) NULL AFTER average_unit_cost,
      ADD fifo_value_change DECIMAL(21,4) NULL AFTER fifo_unit_cost,
      ADD fifo_resulting_inventory_value DECIMAL(21,4) NULL AFTER fifo_value_change
    `);
    await queryRunner.query(`
      INSERT INTO inventory_fifo_cutovers
        (tenant_id, effective_at, migration_rule)
      SELECT id, CURRENT_TIMESTAMP(6), 'OPENING_BALANCE_AT_MOVING_AVERAGE'
      FROM tenants
    `);
    await queryRunner.query(`
      INSERT INTO inventory_fifo_layers
        (id, tenant_id, product_id, location_id, origin_type,
         original_quantity, remaining_quantity, unit_cost, currency, acquired_at)
      SELECT UUID(), ib.tenant_id, ib.product_id, ib.location_id, 'MIGRATION_CUT',
             ib.quantity, ib.quantity,
             COALESCE(iv.average_unit_cost, CAST(p.cost AS DECIMAL(15,4))),
             CASE t.country_code
               WHEN 'MX' THEN 'MXN'
               WHEN 'CL' THEN 'CLP'
               ELSE 'USD'
             END,
             cutover.effective_at
      FROM inventory_balances ib
      INNER JOIN products p ON p.id = ib.product_id AND p.tenant_id = ib.tenant_id
      INNER JOIN tenants t ON t.id = ib.tenant_id
      INNER JOIN inventory_fifo_cutovers cutover ON cutover.tenant_id = ib.tenant_id
      LEFT JOIN inventory_valuations iv
        ON iv.product_id = ib.product_id AND iv.tenant_id = ib.tenant_id
      WHERE ib.quantity > 0
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP COLUMN fifo_resulting_inventory_value,
      DROP COLUMN fifo_value_change,
      DROP COLUMN fifo_unit_cost
    `);
    await queryRunner.query('DROP TABLE inventory_movement_fifo_layers');
    await queryRunner.query('DROP TABLE inventory_fifo_layers');
    await queryRunner.query('DROP TABLE inventory_fifo_cutovers');
  }
}

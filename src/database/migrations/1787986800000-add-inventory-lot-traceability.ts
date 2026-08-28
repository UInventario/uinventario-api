import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryLotTraceability1787986800000 implements MigrationInterface {
  name = 'AddInventoryLotTraceability1787986800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD track_lots BOOLEAN NOT NULL DEFAULT FALSE AFTER barcode
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_lots (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        code VARCHAR(64) NOT NULL,
        normalized_code VARCHAR(64) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_lots_tenant_product_code
          (tenant_id, product_id, normalized_code),
        UNIQUE KEY uq_inventory_lots_id_tenant (id, tenant_id),
        KEY ix_inventory_lots_product_created (tenant_id, product_id, created_at, id),
        CONSTRAINT fk_inventory_lots_product_tenant
          FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_lots_user_tenant
          FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES users(id, tenant_id)
          ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_lot_balances (
        tenant_id CHAR(36) NOT NULL,
        lot_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, lot_id, location_id),
        KEY ix_inventory_lot_balances_location (tenant_id, location_id, lot_id),
        CONSTRAINT fk_inventory_lot_balances_lot_tenant
          FOREIGN KEY (lot_id, tenant_id) REFERENCES inventory_lots(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_lot_balances_location_tenant
          FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_lot_balances_quantity CHECK (quantity >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_movement_lots (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        movement_id CHAR(36) NOT NULL,
        lot_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        quantity_change DECIMAL(18,3) NOT NULL,
        selection_mode ENUM('ORIGIN', 'MANUAL', 'AUTOMATIC', 'RESTORE', 'TRANSFER') NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_movement_lots_movement_lot
          (tenant_id, movement_id, lot_id),
        KEY ix_inventory_movement_lots_lot (tenant_id, lot_id, created_at),
        CONSTRAINT fk_inventory_movement_lots_movement_tenant
          FOREIGN KEY (movement_id) REFERENCES inventory_movements(id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_movement_lots_lot_tenant
          FOREIGN KEY (lot_id, tenant_id) REFERENCES inventory_lots(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_movement_lots_location_tenant
          FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_movement_lots_quantity CHECK (quantity_change <> 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_receipt_lines
      ADD lot_code VARCHAR(64) NULL AFTER received_quantity,
      ADD lot_id CHAR(36) NULL AFTER lot_code,
      ADD CONSTRAINT fk_purchase_receipt_lines_lot_tenant
        FOREIGN KEY (lot_id, tenant_id) REFERENCES inventory_lots(id, tenant_id)
        ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_lot_origins (
        tenant_id CHAR(36) NOT NULL,
        lot_id CHAR(36) NOT NULL,
        purchase_receipt_line_id CHAR(36) NOT NULL,
        quantity DECIMAL(18,3) NOT NULL,
        unit_cost DECIMAL(15,4) NOT NULL,
        currency CHAR(3) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, lot_id, purchase_receipt_line_id),
        CONSTRAINT fk_inventory_lot_origins_lot_tenant
          FOREIGN KEY (lot_id, tenant_id) REFERENCES inventory_lots(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_lot_origins_receipt_line_tenant
          FOREIGN KEY (purchase_receipt_line_id, tenant_id)
          REFERENCES purchase_receipt_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_lot_origins_quantity CHECK (quantity > 0),
        CONSTRAINT ck_inventory_lot_origins_cost CHECK (unit_cost >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_return_lines
      ADD lot_id CHAR(36) NULL AFTER product_id,
      ADD CONSTRAINT fk_purchase_return_lines_lot_tenant
        FOREIGN KEY (lot_id, tenant_id) REFERENCES inventory_lots(id, tenant_id)
        ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE purchase_return_lines
      DROP FOREIGN KEY fk_purchase_return_lines_lot_tenant,
      DROP COLUMN lot_id
    `);
    await queryRunner.query('DROP TABLE inventory_lot_origins');
    await queryRunner.query(`
      ALTER TABLE purchase_receipt_lines
      DROP FOREIGN KEY fk_purchase_receipt_lines_lot_tenant,
      DROP COLUMN lot_id,
      DROP COLUMN lot_code
    `);
    await queryRunner.query('DROP TABLE inventory_movement_lots');
    await queryRunner.query('DROP TABLE inventory_lot_balances');
    await queryRunner.query('DROP TABLE inventory_lots');
    await queryRunner.query('ALTER TABLE products DROP COLUMN track_lots');
  }
}

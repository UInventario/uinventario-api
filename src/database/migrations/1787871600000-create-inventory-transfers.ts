import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryTransfers1787871600000 implements MigrationInterface {
  name = 'CreateInventoryTransfers1787871600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_transfers (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        origin_warehouse_id CHAR(36) NOT NULL, destination_warehouse_id CHAR(36) NOT NULL,
        status VARCHAR(20) NOT NULL, reference VARCHAR(120) NOT NULL,
        reason VARCHAR(160) NOT NULL, creation_idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL, dispatch_idempotency_key VARCHAR(128) NULL,
        created_by_user_id CHAR(36) NOT NULL, dispatched_by_user_id CHAR(36) NULL,
        cancelled_by_user_id CHAR(36) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        dispatched_at DATETIME(6) NULL, cancelled_at DATETIME(6) NULL,
        PRIMARY KEY (id), UNIQUE KEY uq_inventory_transfers_id_tenant (id, tenant_id),
        UNIQUE KEY uq_inventory_transfers_creation_key (tenant_id, creation_idempotency_key),
        UNIQUE KEY uq_inventory_transfers_dispatch_key (tenant_id, dispatch_idempotency_key),
        KEY ix_inventory_transfers_tenant_created (tenant_id, created_at),
        CONSTRAINT fk_inventory_transfers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfers_origin FOREIGN KEY (origin_warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfers_destination FOREIGN KEY (destination_warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfers_created_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfers_dispatched_user FOREIGN KEY (dispatched_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfers_cancelled_user FOREIGN KEY (cancelled_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_transfers_status CHECK (status IN ('DRAFT', 'DISPATCHED', 'CANCELLED')),
        CONSTRAINT ck_inventory_transfers_distinct CHECK (origin_warehouse_id <> destination_warehouse_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_transfer_lines (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, transfer_id CHAR(36) NOT NULL,
        line_number INT NOT NULL, product_id CHAR(36) NOT NULL,
        source_location_id CHAR(36) NOT NULL, destination_location_id CHAR(36) NOT NULL,
        quantity DECIMAL(18,3) NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY uq_inventory_transfer_lines_id_tenant (id, tenant_id),
        UNIQUE KEY uq_inventory_transfer_lines_number (transfer_id, line_number),
        CONSTRAINT fk_inventory_transfer_lines_transfer FOREIGN KEY (transfer_id, tenant_id) REFERENCES inventory_transfers(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_transfer_lines_product FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfer_lines_source FOREIGN KEY (source_location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfer_lines_destination FOREIGN KEY (destination_location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_transfer_lines_quantity CHECK (quantity > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      ADD transfer_id CHAR(36) NULL AFTER sale_line_id,
      ADD transfer_line_id CHAR(36) NULL AFTER transfer_id,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE', 'ADJUSTMENT', 'STATE_TRANSITION', 'SALE', 'TRANSFER_OUT', 'TRANSFER_IN')),
      ADD CONSTRAINT fk_inventory_movements_transfer FOREIGN KEY (transfer_id, tenant_id) REFERENCES inventory_transfers(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_transfer_line FOREIGN KEY (transfer_line_id, tenant_id) REFERENCES inventory_transfer_lines(id, tenant_id) ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const transfers = (await queryRunner.query(
      'SELECT COUNT(*) AS total FROM inventory_transfers',
    )) as Array<{ total: number | string }>;
    if (Number(transfers[0]?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert inventory transfers while documents exist',
      );
    }
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP FOREIGN KEY fk_inventory_movements_transfer_line,
      DROP FOREIGN KEY fk_inventory_movements_transfer,
      DROP CHECK ck_inventory_movements_type,
      DROP COLUMN transfer_line_id,
      DROP COLUMN transfer_id,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE', 'ADJUSTMENT', 'STATE_TRANSITION', 'SALE'))
    `);
    await queryRunner.query('DROP TABLE inventory_transfer_lines');
    await queryRunner.query('DROP TABLE inventory_transfers');
  }
}

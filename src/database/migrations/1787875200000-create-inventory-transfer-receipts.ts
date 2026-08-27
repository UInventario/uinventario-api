import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryTransferReceipts1787875200000 implements MigrationInterface {
  name = 'CreateInventoryTransferReceipts1787875200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_transfers
      DROP CHECK ck_inventory_transfers_status,
      ADD CONSTRAINT ck_inventory_transfers_status
        CHECK (status IN ('DRAFT', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'))
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_transfer_lines
      ADD received_quantity DECIMAL(18,3) NOT NULL DEFAULT 0 AFTER quantity,
      ADD discrepancy_quantity DECIMAL(18,3) NOT NULL DEFAULT 0 AFTER received_quantity,
      ADD CONSTRAINT ck_inventory_transfer_lines_progress CHECK (
        received_quantity >= 0 AND discrepancy_quantity >= 0
        AND received_quantity + discrepancy_quantity <= quantity
      )
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_transfer_receipts (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        transfer_id CHAR(36) NOT NULL, discrepancy_reason VARCHAR(160) NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        received_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_inventory_transfer_receipts_id_tenant (id, tenant_id),
        UNIQUE KEY uq_inventory_transfer_receipts_key (tenant_id, idempotency_key),
        KEY ix_inventory_transfer_receipts_transfer (tenant_id, transfer_id, created_at),
        CONSTRAINT fk_inventory_transfer_receipts_transfer FOREIGN KEY (transfer_id, tenant_id)
          REFERENCES inventory_transfers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_transfer_receipts_user FOREIGN KEY (received_by_user_id)
          REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_transfer_receipt_lines (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        receipt_id CHAR(36) NOT NULL, transfer_line_id CHAR(36) NOT NULL,
        line_number INT NOT NULL, received_quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
        discrepancy_quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
        PRIMARY KEY (id), UNIQUE KEY uq_inventory_transfer_receipt_lines_id_tenant (id, tenant_id),
        UNIQUE KEY uq_inventory_transfer_receipt_lines_number (receipt_id, line_number),
        UNIQUE KEY uq_inventory_transfer_receipt_lines_transfer_line (receipt_id, transfer_line_id),
        CONSTRAINT fk_inventory_transfer_receipt_lines_receipt FOREIGN KEY (receipt_id, tenant_id)
          REFERENCES inventory_transfer_receipts(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_transfer_receipt_lines_transfer_line FOREIGN KEY (transfer_line_id, tenant_id)
          REFERENCES inventory_transfer_lines(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_transfer_receipt_lines_quantity CHECK (
          received_quantity >= 0 AND discrepancy_quantity >= 0
          AND received_quantity + discrepancy_quantity > 0
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      DROP CHECK ck_inventory_movements_quantity_kind,
      ADD receipt_id CHAR(36) NULL AFTER transfer_line_id,
      ADD receipt_line_id CHAR(36) NULL AFTER receipt_id,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE', 'ADJUSTMENT',
          'STATE_TRANSITION', 'SALE', 'TRANSFER_OUT', 'TRANSFER_IN',
          'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY')
      ),
      ADD CONSTRAINT ck_inventory_movements_quantity_kind CHECK (
        (type IN ('STATE_TRANSITION', 'TRANSFER_RECEIPT') AND quantity_change = 0
          AND state_quantity > 0
          AND from_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND to_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND from_state <> to_state)
        OR
        (type NOT IN ('STATE_TRANSITION', 'TRANSFER_RECEIPT') AND quantity_change <> 0
          AND from_state IS NULL AND to_state IS NULL AND state_quantity IS NULL)
      ),
      ADD CONSTRAINT fk_inventory_movements_receipt FOREIGN KEY (receipt_id, tenant_id)
        REFERENCES inventory_transfer_receipts(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_receipt_line FOREIGN KEY (receipt_line_id, tenant_id)
        REFERENCES inventory_transfer_receipt_lines(id, tenant_id) ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const receipts = (await queryRunner.query(
      'SELECT COUNT(*) AS total FROM inventory_transfer_receipts',
    )) as Array<{ total: number | string }>;
    if (Number(receipts[0]?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert inventory transfer receipts while documents exist',
      );
    }
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP FOREIGN KEY fk_inventory_movements_receipt_line,
      DROP FOREIGN KEY fk_inventory_movements_receipt,
      DROP CHECK ck_inventory_movements_quantity_kind,
      DROP CHECK ck_inventory_movements_type,
      DROP COLUMN receipt_line_id,
      DROP COLUMN receipt_id,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE', 'ADJUSTMENT',
          'STATE_TRANSITION', 'SALE', 'TRANSFER_OUT', 'TRANSFER_IN')
      ),
      ADD CONSTRAINT ck_inventory_movements_quantity_kind CHECK (
        (type = 'STATE_TRANSITION' AND quantity_change = 0 AND state_quantity > 0
          AND from_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND to_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND from_state <> to_state)
        OR
        (type <> 'STATE_TRANSITION' AND quantity_change <> 0
          AND from_state IS NULL AND to_state IS NULL AND state_quantity IS NULL)
      )
    `);
    await queryRunner.query('DROP TABLE inventory_transfer_receipt_lines');
    await queryRunner.query('DROP TABLE inventory_transfer_receipts');
    await queryRunner.query(`
      ALTER TABLE inventory_transfer_lines
      DROP CHECK ck_inventory_transfer_lines_progress,
      DROP COLUMN discrepancy_quantity,
      DROP COLUMN received_quantity
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_transfers
      DROP CHECK ck_inventory_transfers_status,
      ADD CONSTRAINT ck_inventory_transfers_status
        CHECK (status IN ('DRAFT', 'DISPATCHED', 'CANCELLED'))
    `);
  }
}

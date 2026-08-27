import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryCounts1787954400000 implements MigrationInterface {
  name = 'CreateInventoryCounts1787954400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE inventory_counts (
      id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
      product_id CHAR(36) NOT NULL, location_id CHAR(36) NOT NULL,
      snapshot_quantity DECIMAL(18,3) NOT NULL,
      counted_quantity DECIMAL(18,3) NOT NULL,
      variance_quantity DECIMAL(18,3) NOT NULL,
      reason VARCHAR(160) NOT NULL, reference VARCHAR(120) NOT NULL,
      device_captured_at DATETIME(6) NOT NULL,
      created_by_user_id CHAR(36) NOT NULL,
      movement_id CHAR(36) NULL,
      idempotency_key VARCHAR(128) NOT NULL,
      request_fingerprint CHAR(64) NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (id),
      UNIQUE KEY uq_inventory_counts_tenant_idempotency (tenant_id, idempotency_key),
      UNIQUE KEY uq_inventory_counts_movement (movement_id),
      KEY ix_inventory_counts_target (tenant_id, product_id, location_id, created_at),
      CONSTRAINT fk_inventory_counts_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_counts_product_tenant FOREIGN KEY (product_id, tenant_id)
        REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_counts_location_tenant FOREIGN KEY (location_id, tenant_id)
        REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_counts_user FOREIGN KEY (created_by_user_id)
        REFERENCES users(id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_counts_movement FOREIGN KEY (movement_id)
        REFERENCES inventory_movements(id) ON DELETE RESTRICT,
      CONSTRAINT ck_inventory_counts_nonnegative CHECK (
        snapshot_quantity >= 0 AND counted_quantity >= 0
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE inventory_counts');
  }
}

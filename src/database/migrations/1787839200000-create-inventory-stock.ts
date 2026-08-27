import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryStock1787839200000 implements MigrationInterface {
  name = 'CreateInventoryStock1787839200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE locations ADD UNIQUE KEY uq_locations_id_tenant (id, tenant_id)',
    );
    await queryRunner.query(`
      CREATE TABLE inventory_balances (
        tenant_id CHAR(36) NOT NULL, product_id CHAR(36) NOT NULL, location_id CHAR(36) NOT NULL,
        quantity DECIMAL(18,3) NOT NULL DEFAULT 0,
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, product_id, location_id),
        CONSTRAINT fk_inventory_balances_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_balances_product_tenant FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_balances_location_tenant FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_inventory_balances_nonnegative CHECK (quantity >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_movements (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, product_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL, type VARCHAR(20) NOT NULL,
        quantity_change DECIMAL(18,3) NOT NULL, resulting_quantity DECIMAL(18,3) NOT NULL,
        reason VARCHAR(160) NOT NULL, reference VARCHAR(120) NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_movements_tenant_idempotency (tenant_id, idempotency_key),
        KEY ix_inventory_movements_product_location (tenant_id, product_id, location_id, created_at),
        CONSTRAINT fk_inventory_movements_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_inventory_movements_product_tenant FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_movements_location_tenant FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_movements_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_inventory_movements_type CHECK (type IN ('INITIAL', 'ENTRY', 'ADJUSTMENT')),
        CONSTRAINT ck_inventory_movements_quantity_nonzero CHECK (quantity_change <> 0),
        CONSTRAINT ck_inventory_movements_result_nonnegative CHECK (resulting_quantity >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE inventory_movements');
    await queryRunner.query('DROP TABLE inventory_balances');
    await queryRunner.query(
      'ALTER TABLE locations DROP KEY uq_locations_id_tenant',
    );
  }
}

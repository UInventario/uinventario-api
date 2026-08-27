import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductReservations1787940000000 implements MigrationInterface {
  name = 'CreateProductReservations1787940000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE product_reservations (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL, warehouse_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL, customer_id CHAR(36) NOT NULL,
        reservation_number VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL,
        expires_at DATETIME(6) NOT NULL, created_by_user_id CHAR(36) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_product_reservations_id_tenant (id, tenant_id),
        UNIQUE KEY uq_product_reservations_number (tenant_id, reservation_number),
        UNIQUE KEY uq_product_reservations_key (tenant_id, idempotency_key),
        KEY ix_product_reservations_branch_status (tenant_id, branch_id, status, expires_at),
        CONSTRAINT fk_product_reservations_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_product_reservations_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_product_reservations_warehouse FOREIGN KEY (warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_product_reservations_location FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_product_reservations_customer FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_product_reservations_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_product_reservations_status CHECK (status IN ('ACTIVE')),
        CONSTRAINT ck_product_reservations_expiry CHECK (expires_at > created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE product_reservation_lines (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        reservation_id CHAR(36) NOT NULL, line_number INT NOT NULL,
        product_id CHAR(36) NOT NULL, quantity DECIMAL(18,3) NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY uq_product_reservation_lines_id_tenant (id, tenant_id),
        UNIQUE KEY uq_product_reservation_lines_number (reservation_id, line_number),
        UNIQUE KEY uq_product_reservation_lines_product (reservation_id, product_id),
        CONSTRAINT fk_product_reservation_lines_reservation FOREIGN KEY (reservation_id, tenant_id)
          REFERENCES product_reservations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_product_reservation_lines_product FOREIGN KEY (product_id, tenant_id)
          REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_product_reservation_lines_quantity CHECK (quantity > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      ADD reservation_id CHAR(36) NULL AFTER purchase_return_line_id,
      ADD reservation_line_id CHAR(36) NULL AFTER reservation_id,
      ADD CONSTRAINT fk_inventory_movements_reservation FOREIGN KEY (reservation_id, tenant_id)
        REFERENCES product_reservations(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_reservation_line FOREIGN KEY (reservation_line_id, tenant_id)
        REFERENCES product_reservation_lines(id, tenant_id) ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP FOREIGN KEY fk_inventory_movements_reservation_line,
      DROP FOREIGN KEY fk_inventory_movements_reservation,
      DROP COLUMN reservation_line_id,
      DROP COLUMN reservation_id
    `);
    await queryRunner.query('DROP TABLE product_reservation_lines');
    await queryRunner.query('DROP TABLE product_reservations');
  }
}

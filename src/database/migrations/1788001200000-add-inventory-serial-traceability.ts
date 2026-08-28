import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventorySerialTraceability1788001200000 implements MigrationInterface {
  name = 'AddInventorySerialTraceability1788001200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD track_serials BOOLEAN NOT NULL DEFAULT FALSE AFTER track_lots
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_serials (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        serial_number VARCHAR(120) NOT NULL,
        normalized_serial VARCHAR(120) NOT NULL,
        status ENUM('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT', 'SOLD',
                    'RETURNED_TO_SUPPLIER', 'REMOVED') NOT NULL,
        current_location_id CHAR(36) NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_serials_tenant_serial
          (tenant_id, normalized_serial),
        UNIQUE KEY uq_inventory_serials_id_tenant (id, tenant_id),
        KEY ix_inventory_serials_product_status
          (tenant_id, product_id, status, current_location_id),
        CONSTRAINT fk_inventory_serials_product_tenant
          FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_serials_location_tenant
          FOREIGN KEY (current_location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_serials_user_tenant
          FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES users(id, tenant_id)
          ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_serial_events (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        serial_id CHAR(36) NOT NULL,
        movement_id CHAR(36) NOT NULL,
        from_status ENUM('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT', 'SOLD',
                         'RETURNED_TO_SUPPLIER', 'REMOVED') NULL,
        to_status ENUM('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT', 'SOLD',
                       'RETURNED_TO_SUPPLIER', 'REMOVED') NOT NULL,
        from_location_id CHAR(36) NULL,
        to_location_id CHAR(36) NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_inventory_serial_events_movement_serial
          (tenant_id, movement_id, serial_id),
        KEY ix_inventory_serial_events_serial
          (tenant_id, serial_id, created_at, id),
        CONSTRAINT fk_inventory_serial_events_serial_tenant
          FOREIGN KEY (serial_id, tenant_id) REFERENCES inventory_serials(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_serial_events_movement
          FOREIGN KEY (movement_id) REFERENCES inventory_movements(id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_serial_events_from_location_tenant
          FOREIGN KEY (from_location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_serial_events_to_location_tenant
          FOREIGN KEY (to_location_id, tenant_id) REFERENCES locations(id, tenant_id)
          ON DELETE RESTRICT,
        CONSTRAINT fk_inventory_serial_events_user_tenant
          FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES users(id, tenant_id)
          ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_transfer_lines
      ADD serial_numbers JSON NULL AFTER quantity
    `);
    await queryRunner.query(`
      ALTER TABLE product_reservation_lines
      ADD serial_numbers JSON NULL AFTER quantity
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE product_reservation_lines DROP COLUMN serial_numbers',
    );
    await queryRunner.query(
      'ALTER TABLE inventory_transfer_lines DROP COLUMN serial_numbers',
    );
    await queryRunner.query('DROP TABLE inventory_serial_events');
    await queryRunner.query('DROP TABLE inventory_serials');
    await queryRunner.query('ALTER TABLE products DROP COLUMN track_serials');
  }
}

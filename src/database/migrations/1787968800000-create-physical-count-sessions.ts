import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePhysicalCountSessions1787968800000 implements MigrationInterface {
  name = 'CreatePhysicalCountSessions1787968800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE inventory_count_sessions (
      id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
      branch_id CHAR(36) NOT NULL, warehouse_id CHAR(36) NOT NULL,
      location_id CHAR(36) NOT NULL, status VARCHAR(16) NOT NULL,
      blind BOOLEAN NOT NULL DEFAULT FALSE,
      idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
      created_by_user_id CHAR(36) NOT NULL, closed_by_user_id CHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      closed_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_inventory_count_sessions_id_tenant (id, tenant_id),
      UNIQUE KEY uq_inventory_count_sessions_idempotency (tenant_id, idempotency_key),
      KEY ix_inventory_count_sessions_scope (tenant_id, warehouse_id, status, created_at),
      CONSTRAINT fk_inventory_count_sessions_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_count_sessions_branch_tenant FOREIGN KEY (branch_id, tenant_id)
        REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_count_sessions_warehouse_tenant FOREIGN KEY (warehouse_id, tenant_id)
        REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_count_sessions_location_tenant FOREIGN KEY (location_id, tenant_id)
        REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_count_sessions_creator FOREIGN KEY (created_by_user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_count_sessions_closer FOREIGN KEY (closed_by_user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT ck_inventory_count_sessions_status CHECK (status IN ('OPEN', 'CLOSED'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await queryRunner.query(`CREATE TABLE inventory_count_session_lines (
      id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
      session_id CHAR(36) NOT NULL, product_id CHAR(36) NOT NULL,
      snapshot_quantity DECIMAL(18,3) NOT NULL,
      counted_quantity DECIMAL(18,3) NULL, variance_quantity DECIMAL(18,3) NULL,
      attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
      counted_by_user_id CHAR(36) NULL, counted_at DATETIME(6) NULL,
      movement_id CHAR(36) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_inventory_count_session_lines_id_tenant (id, tenant_id),
      UNIQUE KEY uq_inventory_count_session_product (session_id, product_id),
      UNIQUE KEY uq_inventory_count_session_movement (movement_id),
      CONSTRAINT fk_inventory_count_session_lines_session FOREIGN KEY (session_id, tenant_id)
        REFERENCES inventory_count_sessions(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_count_session_lines_product FOREIGN KEY (product_id, tenant_id)
        REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_count_session_lines_counter FOREIGN KEY (counted_by_user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_count_session_lines_movement FOREIGN KEY (movement_id)
        REFERENCES inventory_movements(id) ON DELETE RESTRICT,
      CONSTRAINT ck_inventory_count_session_lines_quantities CHECK (
        snapshot_quantity >= 0 AND (counted_quantity IS NULL OR counted_quantity >= 0)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await queryRunner.query(`CREATE TABLE inventory_count_attempts (
      id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
      session_id CHAR(36) NOT NULL, line_id CHAR(36) NOT NULL,
      attempt_number INT UNSIGNED NOT NULL,
      counted_quantity DECIMAL(18,3) NOT NULL,
      counted_by_user_id CHAR(36) NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (id),
      UNIQUE KEY uq_inventory_count_attempt_number (line_id, attempt_number),
      KEY ix_inventory_count_attempts_session (tenant_id, session_id, created_at),
      CONSTRAINT fk_inventory_count_attempts_session FOREIGN KEY (session_id, tenant_id)
        REFERENCES inventory_count_sessions(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_count_attempts_line FOREIGN KEY (line_id, tenant_id)
        REFERENCES inventory_count_session_lines(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_count_attempts_user FOREIGN KEY (counted_by_user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
      CONSTRAINT ck_inventory_count_attempts_quantity CHECK (counted_quantity >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE inventory_count_attempts');
    await queryRunner.query('DROP TABLE inventory_count_session_lines');
    await queryRunner.query('DROP TABLE inventory_count_sessions');
  }
}

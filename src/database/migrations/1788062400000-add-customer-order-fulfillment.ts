import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCustomerOrderFulfillment1788062400000 implements MigrationInterface {
  name = 'AddCustomerOrderFulfillment1788062400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE customer_order_fulfillments (
        order_id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        method VARCHAR(16) NOT NULL, status VARCHAR(24) NOT NULL,
        recipient_name VARCHAR(120) NULL, recipient_phone VARCHAR(40) NULL,
        address_line1 VARCHAR(180) NULL, address_line2 VARCHAR(180) NULL,
        city VARCHAR(100) NULL, region VARCHAR(100) NULL,
        postal_code VARCHAR(24) NULL, country_code CHAR(2) NULL,
        carrier_code VARCHAR(40) NULL, carrier_name VARCHAR(100) NULL,
        delivery_cost DECIMAL(18,2) NOT NULL DEFAULT 0,
        window_start DATETIME(6) NOT NULL, window_end DATETIME(6) NOT NULL,
        assigned_user_id CHAR(36) NULL, delivered_user_id CHAR(36) NULL,
        tracking_reference VARCHAR(120) NULL,
        attempt_count INT NOT NULL DEFAULT 0, last_error_code VARCHAR(64) NULL,
        last_attempt_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (order_id),
        UNIQUE KEY uq_customer_order_fulfillments_order_tenant (order_id, tenant_id),
        KEY ix_customer_order_fulfillments_queue (tenant_id, method, status, window_start),
        CONSTRAINT fk_customer_order_fulfillments_order
          FOREIGN KEY (order_id, tenant_id) REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_order_fulfillments_assigned_user
          FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_order_fulfillments_delivered_user
          FOREIGN KEY (delivered_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_order_fulfillments_method CHECK (method IN ('PICKUP', 'DELIVERY')),
        CONSTRAINT ck_customer_order_fulfillments_status CHECK (
          status IN ('PENDING', 'PREPARING', 'READY', 'RETRYABLE_FAILURE', 'DISPATCHED', 'DELIVERED', 'CANCELLED')
        ),
        CONSTRAINT ck_customer_order_fulfillments_cost CHECK (delivery_cost >= 0),
        CONSTRAINT ck_customer_order_fulfillments_window CHECK (window_end > window_start),
        CONSTRAINT ck_customer_order_fulfillments_attempts CHECK (attempt_count >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO customer_order_fulfillments
      (order_id, tenant_id, method, status, delivery_cost, window_start, window_end)
      SELECT id, tenant_id, 'PICKUP',
             CASE status
               WHEN 'PREPARING' THEN 'PREPARING'
               WHEN 'READY' THEN 'READY'
               WHEN 'DELIVERED' THEN 'DELIVERED'
               WHEN 'CANCELLED' THEN 'CANCELLED'
               ELSE 'PENDING'
             END,
             0, created_at, DATE_ADD(created_at, INTERVAL expires_in_hours HOUR)
      FROM customer_orders
    `);
    await queryRunner.query(`
      CREATE TABLE customer_order_dispatch_attempts (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        order_id CHAR(36) NOT NULL, attempt_number INT NOT NULL,
        status VARCHAR(24) NOT NULL, carrier_code VARCHAR(40) NOT NULL,
        tracking_reference VARCHAR(120) NULL, error_code VARCHAR(64) NULL,
        actor_user_id CHAR(36) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_order_dispatch_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_customer_order_dispatch_attempt (order_id, attempt_number),
        KEY ix_customer_order_dispatch_order (tenant_id, order_id, created_at),
        CONSTRAINT fk_customer_order_dispatch_order
          FOREIGN KEY (order_id, tenant_id) REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_order_dispatch_actor
          FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_order_dispatch_status CHECK (status IN ('SUCCEEDED', 'FAILED_RETRYABLE')),
        CONSTRAINT ck_customer_order_dispatch_attempt_number CHECK (attempt_number > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE customer_order_dispatch_attempts');
    await queryRunner.query('DROP TABLE customer_order_fulfillments');
  }
}

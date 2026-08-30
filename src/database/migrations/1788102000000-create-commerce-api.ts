import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCommerceApi1788102000000 implements MigrationInterface {
  name = 'CreateCommerceApi1788102000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE commerce_api_credentials (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        name VARCHAR(80) NOT NULL, key_prefix VARCHAR(20) NOT NULL,
        key_hash CHAR(64) NOT NULL, scopes JSON NOT NULL,
        branch_id CHAR(36) NOT NULL, warehouse_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL, location_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
        rate_limit_per_minute SMALLINT UNSIGNED NOT NULL DEFAULT 60,
        webhook_url VARCHAR(500) NULL, webhook_events JSON NOT NULL,
        webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_by_user_id CHAR(36) NOT NULL, last_used_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_commerce_credentials_id_tenant (id, tenant_id),
        UNIQUE KEY uq_commerce_credentials_name (tenant_id, name),
        UNIQUE KEY uq_commerce_credentials_hash (key_hash),
        KEY ix_commerce_credentials_prefix (key_prefix, active),
        CONSTRAINT fk_commerce_credentials_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_commerce_credentials_branch FOREIGN KEY (branch_id, tenant_id)
          REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_commerce_credentials_warehouse FOREIGN KEY (warehouse_id, tenant_id)
          REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_commerce_credentials_register FOREIGN KEY (cash_register_id, tenant_id)
          REFERENCES cash_registers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_commerce_credentials_location FOREIGN KEY (location_id, tenant_id)
          REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_commerce_credentials_customer FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_commerce_credentials_user FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_commerce_credentials_rate CHECK (rate_limit_per_minute BETWEEN 10 AND 600),
        CONSTRAINT ck_commerce_credentials_webhook CHECK (
          (webhook_enabled = FALSE) OR webhook_url IS NOT NULL
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE commerce_api_usage_windows (
        credential_id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        window_started_at DATETIME NOT NULL, request_count INT UNSIGNED NOT NULL,
        PRIMARY KEY (credential_id, window_started_at),
        KEY ix_commerce_usage_cleanup (window_started_at),
        CONSTRAINT fk_commerce_usage_credential FOREIGN KEY (credential_id, tenant_id)
          REFERENCES commerce_api_credentials(id, tenant_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE commerce_external_orders (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        credential_id CHAR(36) NOT NULL, external_order_id VARCHAR(100) NOT NULL,
        order_id CHAR(36) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_commerce_external_order (credential_id, external_order_id),
        UNIQUE KEY uq_commerce_internal_order (tenant_id, order_id),
        CONSTRAINT fk_commerce_external_credential FOREIGN KEY (credential_id, tenant_id)
          REFERENCES commerce_api_credentials(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_commerce_external_order FOREIGN KEY (order_id, tenant_id)
          REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE commerce_webhook_deliveries (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        credential_id CHAR(36) NOT NULL, event_id VARCHAR(160) NOT NULL,
        event_type VARCHAR(40) NOT NULL, target_url VARCHAR(500) NOT NULL,
        payload JSON NOT NULL, signature CHAR(71) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        error_code VARCHAR(80) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        delivered_at DATETIME(6) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_commerce_webhook_event (credential_id, event_id),
        KEY ix_commerce_webhook_queue (tenant_id, status, updated_at),
        CONSTRAINT fk_commerce_webhook_credential FOREIGN KEY (credential_id, tenant_id)
          REFERENCES commerce_api_credentials(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_commerce_webhook_status CHECK (status IN
          ('PENDING', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'FAILED')),
        CONSTRAINT ck_commerce_webhook_attempts CHECK (attempt_count <= 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE commerce_webhook_deliveries');
    await queryRunner.query('DROP TABLE commerce_external_orders');
    await queryRunner.query('DROP TABLE commerce_api_usage_windows');
    await queryRunner.query('DROP TABLE commerce_api_credentials');
  }
}

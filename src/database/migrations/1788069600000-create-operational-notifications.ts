import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOperationalNotifications1788069600000 implements MigrationInterface {
  name = 'CreateOperationalNotifications1788069600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_RETURN', 'SALES_DISCOUNT', 'SALES_CREDIT', 'SALE_REPRINT',
        'CASH_DRAWER_OPEN', 'CASH_REGISTER_OPEN', 'CASH_REGISTER_CLOSE',
        'CASH_REGISTER_MOVE', 'ACCESS_MANAGE', 'AUDIT_VIEW', 'AUDIT_EXPORT',
        'PRIVACY_MANAGE', 'SUPPLIERS_MANAGE', 'PURCHASE_ORDERS_MANAGE',
        'PURCHASE_ORDERS_APPROVE', 'PURCHASE_RECEIPTS_OVERAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE', 'INVENTORY_EXPIRED_STOCK_OVERRIDE',
        'NOTIFICATIONS_VIEW', 'NOTIFICATIONS_MANAGE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'NOTIFICATIONS_VIEW' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'NOTIFICATIONS_MANAGE' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE notification_preferences (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        recipient_user_id CHAR(36) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        frequency VARCHAR(20) NOT NULL DEFAULT 'IMMEDIATE',
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_notification_preferences_rule
          (tenant_id, recipient_user_id, event_type),
        KEY ix_notification_preferences_tenant (tenant_id, enabled, event_type),
        CONSTRAINT fk_notification_preferences_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_notification_preferences_user
          FOREIGN KEY (recipient_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_notification_preferences_event CHECK (event_type IN (
          'STOCK_LOW', 'LOT_EXPIRING', 'PURCHASE_PENDING',
          'CASH_DIFFERENCE', 'SYNC_FAILED', 'OPERATION_FAILED'
        )),
        CONSTRAINT ck_notification_preferences_frequency CHECK (
          frequency IN ('IMMEDIATE', 'DAILY_DIGEST')
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE notifications (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        recipient_user_id CHAR(36) NOT NULL,
        event_type VARCHAR(32) NOT NULL, source_key VARCHAR(190) NOT NULL,
        title VARCHAR(160) NOT NULL, body VARCHAR(500) NOT NULL,
        severity VARCHAR(16) NOT NULL, branch_id CHAR(36) NULL,
        in_app_visible BOOLEAN NOT NULL DEFAULT TRUE,
        digest_count INT UNSIGNED NOT NULL DEFAULT 1,
        source_occurred_at DATETIME(6) NOT NULL,
        read_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_notifications_id_tenant (id, tenant_id),
        UNIQUE KEY uq_notifications_source
          (tenant_id, recipient_user_id, event_type, source_key),
        KEY ix_notifications_inbox
          (tenant_id, recipient_user_id, in_app_visible, read_at, created_at),
        CONSTRAINT fk_notifications_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_notifications_user FOREIGN KEY (recipient_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_notifications_branch FOREIGN KEY (branch_id, tenant_id)
          REFERENCES branches(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_notifications_event CHECK (event_type IN (
          'STOCK_LOW', 'LOT_EXPIRING', 'PURCHASE_PENDING',
          'CASH_DIFFERENCE', 'SYNC_FAILED', 'OPERATION_FAILED'
        )),
        CONSTRAINT ck_notifications_severity CHECK (
          severity IN ('INFO', 'WARNING', 'CRITICAL')
        ),
        CONSTRAINT ck_notifications_digest_count CHECK (digest_count > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE notification_deliveries (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        notification_id CHAR(36) NOT NULL, channel VARCHAR(12) NOT NULL,
        adapter VARCHAR(40) NOT NULL DEFAULT 'SIMULATOR',
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        error_code VARCHAR(80) NULL, provider_reference VARCHAR(120) NULL,
        delivered_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_notification_deliveries_channel (notification_id, channel),
        KEY ix_notification_deliveries_queue
          (tenant_id, status, next_attempt_at, attempt_count),
        CONSTRAINT fk_notification_deliveries_notification
          FOREIGN KEY (notification_id, tenant_id)
          REFERENCES notifications(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_notification_deliveries_channel CHECK (
          channel IN ('EMAIL', 'PUSH')
        ),
        CONSTRAINT ck_notification_deliveries_status CHECK (
          status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')
        ),
        CONSTRAINT ck_notification_deliveries_attempt CHECK (attempt_count <= 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE notification_deliveries');
    await queryRunner.query('DROP TABLE notifications');
    await queryRunner.query('DROP TABLE notification_preferences');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission IN ('NOTIFICATIONS_VIEW', 'NOTIFICATIONS_MANAGE')",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_RETURN', 'SALES_DISCOUNT', 'SALES_CREDIT', 'SALE_REPRINT',
        'CASH_DRAWER_OPEN', 'CASH_REGISTER_OPEN', 'CASH_REGISTER_CLOSE',
        'CASH_REGISTER_MOVE', 'ACCESS_MANAGE', 'AUDIT_VIEW', 'AUDIT_EXPORT',
        'PRIVACY_MANAGE', 'SUPPLIERS_MANAGE', 'PURCHASE_ORDERS_MANAGE',
        'PURCHASE_ORDERS_APPROVE', 'PURCHASE_RECEIPTS_OVERAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE',
        'INVENTORY_VALUATION_MANAGE', 'INVENTORY_EXPIRED_STOCK_OVERRIDE'
      ))
    `);
  }
}

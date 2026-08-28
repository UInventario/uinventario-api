import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPurchaseOrderLifecycle1787922000000 implements MigrationInterface {
  name = 'AddPurchaseOrderLifecycle1787922000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'PURCHASE_ORDERS_APPROVE' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      ALTER TABLE purchase_orders
      ADD COLUMN approved_at DATETIME(6) NULL AFTER updated_at,
      ADD COLUMN approved_by_user_id CHAR(36) NULL AFTER approved_at,
      ADD COLUMN sent_at DATETIME(6) NULL AFTER approved_by_user_id,
      ADD COLUMN cancelled_at DATETIME(6) NULL AFTER sent_at,
      ADD COLUMN cancelled_by_user_id CHAR(36) NULL AFTER cancelled_at,
      ADD COLUMN cancellation_reason VARCHAR(500) NULL AFTER cancelled_by_user_id,
      ADD CONSTRAINT fk_purchase_orders_approved_user
        FOREIGN KEY (approved_by_user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_purchase_orders_cancelled_user
        FOREIGN KEY (cancelled_by_user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_order_transitions (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        purchase_order_id CHAR(36) NOT NULL,
        from_status VARCHAR(24) NOT NULL,
        to_status VARCHAR(24) NOT NULL,
        reason VARCHAR(500) NULL,
        delivery_mode VARCHAR(24) NULL,
        delivery_recipient VARCHAR(254) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        actor_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_purchase_order_transition_key (tenant_id, idempotency_key),
        KEY ix_purchase_order_transitions_order (tenant_id, purchase_order_id, created_at, id),
        CONSTRAINT fk_purchase_order_transitions_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_purchase_order_transitions_order FOREIGN KEY (purchase_order_id, tenant_id)
          REFERENCES purchase_orders(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_purchase_order_transitions_user FOREIGN KEY (actor_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_purchase_order_transitions_status CHECK (
          from_status IN ('DRAFT', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')
          AND to_status IN ('DRAFT', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')
        ),
        CONSTRAINT ck_purchase_order_transitions_delivery CHECK (
          (to_status = 'SENT' AND delivery_mode = 'SIMULATED')
          OR (to_status <> 'SENT' AND delivery_mode IS NULL AND delivery_recipient IS NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE purchase_order_transitions');
    await queryRunner.query(`
      ALTER TABLE purchase_orders
      DROP FOREIGN KEY fk_purchase_orders_approved_user,
      DROP FOREIGN KEY fk_purchase_orders_cancelled_user,
      DROP COLUMN cancellation_reason,
      DROP COLUMN cancelled_by_user_id,
      DROP COLUMN cancelled_at,
      DROP COLUMN sent_at,
      DROP COLUMN approved_by_user_id,
      DROP COLUMN approved_at
    `);
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'PURCHASE_ORDERS_APPROVE'",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'SUPPLIERS_MANAGE',
        'PURCHASE_ORDERS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }
}

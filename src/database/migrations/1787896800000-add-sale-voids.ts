import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSaleVoids1787896800000 implements MigrationInterface {
  name = 'AddSaleVoids1787896800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID', 'ACCESS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'SALES_VOID' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      DROP CHECK ck_sales_status,
      ADD voided_by_user_id CHAR(36) NULL AFTER status,
      ADD void_reason VARCHAR(240) NULL AFTER voided_by_user_id,
      ADD void_idempotency_key VARCHAR(128) NULL AFTER void_reason,
      ADD void_request_fingerprint CHAR(64) NULL AFTER void_idempotency_key,
      ADD voided_at DATETIME(6) NULL AFTER void_request_fingerprint,
      ADD UNIQUE KEY uq_sales_tenant_void_idempotency (tenant_id, void_idempotency_key),
      ADD KEY ix_sales_voided_by (voided_by_user_id),
      ADD CONSTRAINT fk_sales_voided_by_user FOREIGN KEY (voided_by_user_id)
        REFERENCES users(id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_sales_status CHECK (status IN ('COMPLETED', 'VOIDED')),
      ADD CONSTRAINT ck_sales_void_state CHECK (
        (status = 'COMPLETED' AND voided_by_user_id IS NULL AND void_reason IS NULL
          AND void_idempotency_key IS NULL AND void_request_fingerprint IS NULL AND voided_at IS NULL)
        OR
        (status = 'VOIDED' AND voided_by_user_id IS NOT NULL AND void_reason IS NOT NULL
          AND void_idempotency_key IS NOT NULL AND void_request_fingerprint IS NOT NULL
          AND voided_at IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sale_payments
      ADD status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED' AFTER change_amount,
      ADD reversed_by_user_id CHAR(36) NULL AFTER status,
      ADD reversed_at DATETIME(6) NULL AFTER reversed_by_user_id,
      ADD KEY ix_sale_payments_reversed_by (reversed_by_user_id),
      ADD CONSTRAINT fk_sale_payments_reversed_by_user FOREIGN KEY (reversed_by_user_id)
        REFERENCES users(id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_sale_payments_status CHECK (status IN ('COMPLETED', 'REVERSED')),
      ADD CONSTRAINT ck_sale_payments_reversal_state CHECK (
        (status = 'COMPLETED' AND reversed_by_user_id IS NULL AND reversed_at IS NULL)
        OR (status = 'REVERSED' AND reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_sale_link,
      DROP CHECK ck_inventory_movements_type,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'STATE_TRANSITION', 'SALE', 'SALE_VOID',
          'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY')
      ),
      ADD CONSTRAINT ck_inventory_movements_sale_link CHECK (
        (type IN ('SALE', 'SALE_VOID') AND sale_id IS NOT NULL AND sale_line_id IS NOT NULL)
        OR (type NOT IN ('SALE', 'SALE_VOID') AND sale_id IS NULL AND sale_line_id IS NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE audit_events
      ADD before_data JSON NULL AFTER event_key,
      ADD after_data JSON NULL AFTER before_data
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE audit_events DROP COLUMN after_data, DROP COLUMN before_data
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_sale_link,
      DROP CHECK ck_inventory_movements_type,
      ADD CONSTRAINT ck_inventory_movements_type CHECK (
        type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE',
          'ADJUSTMENT', 'STATE_TRANSITION', 'SALE', 'TRANSFER_OUT', 'TRANSFER_IN',
          'TRANSFER_RECEIPT', 'TRANSFER_DISCREPANCY')
      ),
      ADD CONSTRAINT ck_inventory_movements_sale_link CHECK (
        (type = 'SALE' AND sale_id IS NOT NULL AND sale_line_id IS NOT NULL)
        OR (type <> 'SALE' AND sale_id IS NULL AND sale_line_id IS NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sale_payments
      DROP CHECK ck_sale_payments_reversal_state,
      DROP CHECK ck_sale_payments_status,
      DROP FOREIGN KEY fk_sale_payments_reversed_by_user,
      DROP KEY ix_sale_payments_reversed_by,
      DROP COLUMN reversed_at,
      DROP COLUMN reversed_by_user_id,
      DROP COLUMN status
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      DROP CHECK ck_sales_void_state,
      DROP CHECK ck_sales_status,
      DROP FOREIGN KEY fk_sales_voided_by_user,
      DROP KEY ix_sales_voided_by,
      DROP KEY uq_sales_tenant_void_idempotency,
      DROP COLUMN voided_at,
      DROP COLUMN void_request_fingerprint,
      DROP COLUMN void_idempotency_key,
      DROP COLUMN void_reason,
      DROP COLUMN voided_by_user_id,
      ADD CONSTRAINT ck_sales_status CHECK (status IN ('COMPLETED'))
    `);
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'SALES_VOID'",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'ACCESS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }
}

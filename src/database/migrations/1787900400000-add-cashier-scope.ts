import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCashierScope1787900400000 implements MigrationInterface {
  name = 'AddCashierScope1787900400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT r.id, r.tenant_id, permissions.permission
      FROM roles r
      CROSS JOIN (
        SELECT 'SALES_DISCOUNT' AS permission UNION ALL
        SELECT 'SALE_REPRINT' UNION ALL
        SELECT 'CASH_REGISTER_OPEN' UNION ALL
        SELECT 'CASH_REGISTER_CLOSE' UNION ALL
        SELECT 'CASH_REGISTER_MOVE'
      ) permissions
      WHERE r.code = 'ADMIN'
    `);
    await queryRunner.query(`
      ALTER TABLE cash_registers
      ADD UNIQUE KEY uq_cash_registers_id_tenant_branch (id, tenant_id, branch_id)
    `);
    await queryRunner.query(`
      CREATE TABLE user_cash_register_access (
        user_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (user_id, cash_register_id),
        KEY ix_user_cash_register_access_tenant_branch (tenant_id, branch_id),
        KEY ix_user_cash_register_access_register (cash_register_id, tenant_id, branch_id),
        CONSTRAINT fk_user_cash_register_access_user_tenant
          FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_user_cash_register_access_branch_tenant
          FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_user_cash_register_access_register_scope
          FOREIGN KEY (cash_register_id, tenant_id, branch_id)
          REFERENCES cash_registers(id, tenant_id, branch_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO user_cash_register_access (user_id, tenant_id, branch_id, cash_register_id)
      SELECT uba.user_id, uba.tenant_id, uba.branch_id, cr.id
      FROM user_branch_access uba
      INNER JOIN cash_registers cr ON cr.tenant_id = uba.tenant_id
        AND cr.branch_id = uba.branch_id
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE user_cash_register_access');
    await queryRunner.query(
      'ALTER TABLE cash_registers DROP KEY uq_cash_registers_id_tenant_branch',
    );
    await queryRunner.query(`
      DELETE FROM role_permissions WHERE permission IN (
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID', 'ACCESS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }
}

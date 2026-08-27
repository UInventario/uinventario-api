import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInventoryAccessControl1787882400000 implements MigrationInterface {
  name = 'CreateInventoryAccessControl1787882400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE roles
      ADD UNIQUE KEY uq_roles_id_tenant (id, tenant_id)
    `);
    await queryRunner.query(`
      ALTER TABLE users
      ADD UNIQUE KEY uq_users_id_tenant (id, tenant_id)
    `);
    await queryRunner.query(`
      ALTER TABLE user_roles
      DROP FOREIGN KEY fk_user_roles_user,
      DROP FOREIGN KEY fk_user_roles_role,
      ADD tenant_id CHAR(36) NULL AFTER role_id
    `);
    await queryRunner.query(`
      UPDATE user_roles ur
      INNER JOIN users u ON u.id = ur.user_id
      SET ur.tenant_id = u.tenant_id
    `);
    await queryRunner.query(`
      ALTER TABLE user_roles
      MODIFY tenant_id CHAR(36) NOT NULL,
      ADD KEY ix_user_roles_role_tenant (role_id, tenant_id),
      ADD CONSTRAINT fk_user_roles_user_tenant FOREIGN KEY (user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE CASCADE,
      ADD CONSTRAINT fk_user_roles_role_tenant FOREIGN KEY (role_id, tenant_id)
        REFERENCES roles(id, tenant_id) ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE TABLE role_permissions (
        role_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        permission VARCHAR(40) NOT NULL,
        PRIMARY KEY (role_id, permission),
        KEY ix_role_permissions_tenant (tenant_id, permission),
        CONSTRAINT fk_role_permissions_role_tenant FOREIGN KEY (role_id, tenant_id)
          REFERENCES roles(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
          'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'ACCESS_MANAGE',
          'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
          'INVENTORY_COUNT', 'INVENTORY_APPROVE'
        ))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE user_branch_access (
        user_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        PRIMARY KEY (user_id, branch_id),
        KEY ix_user_branch_access_branch (branch_id, tenant_id),
        CONSTRAINT fk_user_branch_access_user_tenant FOREIGN KEY (user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_user_branch_access_branch_tenant FOREIGN KEY (branch_id, tenant_id)
          REFERENCES branches(id, tenant_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO role_permissions (role_id, tenant_id, permission)
      SELECT r.id, r.tenant_id, permissions.permission
      FROM roles r
      CROSS JOIN (
        SELECT 'TENANT_MANAGE' AS permission UNION ALL
        SELECT 'PRODUCTS_MANAGE' UNION ALL
        SELECT 'SALES_MANAGE' UNION ALL
        SELECT 'ACCESS_MANAGE' UNION ALL
        SELECT 'INVENTORY_VIEW' UNION ALL
        SELECT 'INVENTORY_ADJUST' UNION ALL
        SELECT 'INVENTORY_TRANSFER' UNION ALL
        SELECT 'INVENTORY_COUNT' UNION ALL
        SELECT 'INVENTORY_APPROVE'
      ) permissions
      WHERE r.code = 'ADMIN'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE user_branch_access');
    await queryRunner.query('DROP TABLE role_permissions');
    await queryRunner.query(`
      ALTER TABLE user_roles
      DROP FOREIGN KEY fk_user_roles_role_tenant,
      DROP FOREIGN KEY fk_user_roles_user_tenant,
      DROP KEY ix_user_roles_role_tenant,
      DROP COLUMN tenant_id,
      ADD CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
      ADD CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id)
        REFERENCES roles(id) ON DELETE RESTRICT
    `);
    await queryRunner.query('ALTER TABLE users DROP KEY uq_users_id_tenant');
    await queryRunner.query('ALTER TABLE roles DROP KEY uq_roles_id_tenant');
  }
}

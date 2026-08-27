import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSuppliers1787911200000 implements MigrationInterface {
  name = 'CreateSuppliers1787911200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT', 'SUPPLIERS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT id, tenant_id, 'SUPPLIERS_MANAGE' FROM roles WHERE code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE suppliers (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        legal_name VARCHAR(180) NOT NULL,
        trade_name VARCHAR(180) NULL,
        country_code CHAR(2) NOT NULL,
        identifier_type VARCHAR(24) NOT NULL,
        tax_identifier VARCHAR(64) NOT NULL,
        normalized_tax_identifier VARCHAR(64) NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_suppliers_id_tenant (id, tenant_id),
        UNIQUE KEY uq_suppliers_tenant_identifier (tenant_id, normalized_tax_identifier),
        KEY ix_suppliers_tenant_status_name (tenant_id, active, legal_name, id),
        CONSTRAINT fk_suppliers_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT ck_suppliers_version CHECK (version > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE supplier_contacts (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        supplier_id CHAR(36) NOT NULL,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(254) NULL,
        phone VARCHAR(40) NULL,
        role VARCHAR(80) NULL,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY ix_supplier_contacts_supplier (tenant_id, supplier_id, is_primary, name),
        CONSTRAINT fk_supplier_contacts_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_supplier_contacts_supplier FOREIGN KEY (supplier_id, tenant_id)
          REFERENCES suppliers(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_supplier_contacts_method CHECK (email IS NOT NULL OR phone IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE supplier_contacts');
    await queryRunner.query('DROP TABLE suppliers');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission = 'SUPPLIERS_MANAGE'",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }
}

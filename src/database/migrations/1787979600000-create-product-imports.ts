import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductImports1787979600000 implements MigrationInterface {
  name = 'CreateProductImports1787979600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE product_imports (
      id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, status VARCHAR(20) NOT NULL,
      policy VARCHAR(20) NOT NULL DEFAULT 'ATOMIC', template_version VARCHAR(10) NOT NULL,
      source_filename VARCHAR(160) NOT NULL, source_hash CHAR(64) NOT NULL,
      row_count INT UNSIGNED NOT NULL, create_count INT UNSIGNED NOT NULL,
      update_count INT UNSIGNED NOT NULL, unchanged_count INT UNSIGNED NOT NULL,
      error_count INT UNSIGNED NOT NULL, created_by_user_id CHAR(36) NOT NULL,
      confirmed_by_user_id CHAR(36) NULL, confirmation_key VARCHAR(128) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), confirmed_at DATETIME(6) NULL,
      PRIMARY KEY (id), UNIQUE KEY uq_product_import_id_tenant (id, tenant_id),
      UNIQUE KEY uq_product_import_confirmation (tenant_id, confirmation_key),
      CONSTRAINT fk_product_import_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_product_import_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      CONSTRAINT fk_product_import_confirmed_by FOREIGN KEY (confirmed_by_user_id) REFERENCES users(id),
      CONSTRAINT ck_product_import_status CHECK (status IN ('PREVIEWED','CONFIRMED')),
      CONSTRAINT ck_product_import_policy CHECK (policy = 'ATOMIC')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await queryRunner.query(`CREATE TABLE product_import_rows (
      id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, import_id CHAR(36) NOT NULL,
      source_row INT UNSIGNED NOT NULL, action VARCHAR(20) NOT NULL, product_id CHAR(36) NULL,
      preview_version INT UNSIGNED NULL, name VARCHAR(160) NOT NULL, sku VARCHAR(40) NOT NULL,
      barcode VARCHAR(64) NULL, category_name VARCHAR(80) NULL, brand_name VARCHAR(120) NULL,
      cost DECIMAL(15,2) NULL, price DECIMAL(15,2) NULL, active BOOLEAN NOT NULL,
      errors JSON NULL, PRIMARY KEY (id),
      UNIQUE KEY uq_product_import_row_number (import_id, source_row),
      CONSTRAINT fk_product_import_row_import FOREIGN KEY (import_id, tenant_id)
        REFERENCES product_imports(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT ck_product_import_row_action CHECK (action IN ('CREATE','UPDATE','UNCHANGED','ERROR'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE product_import_rows');
    await queryRunner.query('DROP TABLE product_imports');
  }
}

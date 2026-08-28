import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDataExports1787976000000 implements MigrationInterface {
  name = 'CreateDataExports1787976000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE data_exports (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        requested_by_user_id CHAR(36) NOT NULL,
        dataset VARCHAR(20) NOT NULL,
        format VARCHAR(10) NOT NULL,
        status VARCHAR(20) NOT NULL,
        filters JSON NOT NULL,
        excluded_columns JSON NOT NULL,
        row_count INT UNSIGNED NULL,
        file_content LONGBLOB NULL,
        content_type VARCHAR(100) NULL,
        filename VARCHAR(180) NULL,
        error_code VARCHAR(80) NULL,
        expires_at DATETIME(6) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        PRIMARY KEY (id),
        KEY ix_data_exports_owner (tenant_id, requested_by_user_id, created_at),
        KEY ix_data_exports_expiration (status, expires_at),
        CONSTRAINT fk_data_exports_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_data_exports_user FOREIGN KEY (requested_by_user_id)
          REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT ck_data_exports_dataset CHECK (
          dataset IN ('PRODUCTS', 'STOCK', 'SALES', 'MOVEMENTS')
        ),
        CONSTRAINT ck_data_exports_format CHECK (format IN ('CSV', 'XLSX')),
        CONSTRAINT ck_data_exports_status CHECK (
          status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED')
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE data_exports');
  }
}

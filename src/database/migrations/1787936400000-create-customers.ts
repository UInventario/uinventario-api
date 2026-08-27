import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCustomers1787936400000 implements MigrationInterface {
  name = 'CreateCustomers1787936400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE customers (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        name VARCHAR(160) NOT NULL,
        normalized_name VARCHAR(160) NOT NULL,
        identifier VARCHAR(80) NULL,
        normalized_identifier VARCHAR(80) NULL,
        email VARCHAR(254) NULL,
        normalized_email VARCHAR(254) NULL,
        phone VARCHAR(32) NULL,
        normalized_phone VARCHAR(32) NULL,
        data_processing_consent BOOLEAN NOT NULL DEFAULT FALSE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customers_id_tenant (id, tenant_id),
        UNIQUE KEY uq_customers_identifier (tenant_id, normalized_identifier),
        UNIQUE KEY uq_customers_email (tenant_id, normalized_email),
        UNIQUE KEY uq_customers_phone (tenant_id, normalized_phone),
        KEY ix_customers_search (tenant_id, active, normalized_name),
        CONSTRAINT fk_customers_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT ck_customers_consent CHECK (
          data_processing_consent = TRUE OR (email IS NULL AND phone IS NULL)
        ),
        CONSTRAINT ck_customers_version CHECK (version > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      ADD customer_id CHAR(36) NULL AFTER created_by_user_id,
      ADD KEY ix_sales_customer (tenant_id, customer_id, created_at),
      ADD CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id, tenant_id)
        REFERENCES customers(id, tenant_id) ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sales
      DROP FOREIGN KEY fk_sales_customer,
      DROP KEY ix_sales_customer,
      DROP COLUMN customer_id
    `);
    await queryRunner.query('DROP TABLE customers');
  }
}

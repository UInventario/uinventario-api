import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCashRegisterShifts1787886000000 implements MigrationInterface {
  name = 'CreateCashRegisterShifts1787886000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE cash_register_shifts (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL,
        opened_by_user_id CHAR(36) NOT NULL,
        opening_amount DECIMAL(15,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        opening_idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        opened_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        closed_at DATETIME(6) NULL,
        open_register_id CHAR(36) GENERATED ALWAYS AS
          (CASE WHEN status = 'OPEN' THEN cash_register_id ELSE NULL END) STORED,
        open_user_id CHAR(36) GENERATED ALWAYS AS
          (CASE WHEN status = 'OPEN' THEN opened_by_user_id ELSE NULL END) STORED,
        PRIMARY KEY (id),
        UNIQUE KEY uq_cash_register_shifts_id_tenant (id, tenant_id),
        UNIQUE KEY uq_cash_register_shifts_idempotency (tenant_id, opening_idempotency_key),
        UNIQUE KEY uq_cash_register_shifts_open_register (tenant_id, open_register_id),
        UNIQUE KEY uq_cash_register_shifts_open_user (tenant_id, open_user_id),
        KEY ix_cash_register_shifts_branch_opened (tenant_id, branch_id, opened_at),
        CONSTRAINT fk_cash_register_shifts_branch_tenant
          FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_cash_register_shifts_register_tenant
          FOREIGN KEY (cash_register_id, tenant_id) REFERENCES cash_registers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_cash_register_shifts_user_tenant
          FOREIGN KEY (opened_by_user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_cash_register_shifts_amount CHECK (opening_amount >= 0),
        CONSTRAINT ck_cash_register_shifts_status CHECK (status IN ('OPEN', 'CLOSED')),
        CONSTRAINT ck_cash_register_shifts_closed CHECK (
          (status = 'OPEN' AND closed_at IS NULL) OR
          (status = 'CLOSED' AND closed_at IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      ADD cash_register_shift_id CHAR(36) NULL AFTER cash_register_id,
      ADD KEY ix_sales_cash_register_shift (tenant_id, cash_register_shift_id),
      ADD CONSTRAINT fk_sales_cash_register_shift_tenant
        FOREIGN KEY (cash_register_shift_id, tenant_id)
        REFERENCES cash_register_shifts(id, tenant_id) ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sales
      DROP FOREIGN KEY fk_sales_cash_register_shift_tenant,
      DROP KEY ix_sales_cash_register_shift,
      DROP COLUMN cash_register_shift_id
    `);
    await queryRunner.query('DROP TABLE cash_register_shifts');
  }
}

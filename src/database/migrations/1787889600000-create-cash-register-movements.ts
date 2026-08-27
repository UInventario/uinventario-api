import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCashRegisterMovements1787889600000 implements MigrationInterface {
  name = 'CreateCashRegisterMovements1787889600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE cash_register_movements (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        cash_register_shift_id CHAR(36) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        type VARCHAR(16) NOT NULL,
        amount DECIMAL(15,2) NOT NULL,
        reason VARCHAR(160) NOT NULL,
        reversal_of_id CHAR(36) NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_cash_register_movements_id_tenant (id, tenant_id),
        UNIQUE KEY uq_cash_register_movements_idempotency (tenant_id, idempotency_key),
        UNIQUE KEY uq_cash_register_movements_reversal (tenant_id, reversal_of_id),
        KEY ix_cash_register_movements_shift_created
          (tenant_id, cash_register_shift_id, created_at),
        CONSTRAINT fk_cash_register_movements_shift_tenant
          FOREIGN KEY (cash_register_shift_id, tenant_id)
          REFERENCES cash_register_shifts(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_cash_register_movements_user_tenant
          FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_cash_register_movements_reversal_tenant
          FOREIGN KEY (reversal_of_id, tenant_id)
          REFERENCES cash_register_movements(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_cash_register_movements_amount CHECK (amount > 0),
        CONSTRAINT ck_cash_register_movements_type
          CHECK (type IN ('INCOME', 'WITHDRAWAL', 'REVERSAL')),
        CONSTRAINT ck_cash_register_movements_reversal CHECK (
          (type IN ('INCOME', 'WITHDRAWAL') AND reversal_of_id IS NULL) OR
          (type = 'REVERSAL' AND reversal_of_id IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE cash_register_movements');
  }
}

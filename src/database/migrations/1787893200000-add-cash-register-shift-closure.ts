import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCashRegisterShiftClosure1787893200000 implements MigrationInterface {
  name = 'AddCashRegisterShiftClosure1787893200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE cash_register_shifts
      ADD closed_by_user_id CHAR(36) NULL AFTER opened_by_user_id,
      ADD closing_counted_amount DECIMAL(15,2) NULL AFTER opening_amount,
      ADD expected_cash_at_close DECIMAL(15,2) NULL AFTER closing_counted_amount,
      ADD difference_at_close DECIMAL(15,2) NULL AFTER expected_cash_at_close,
      ADD closing_reason VARCHAR(160) NULL AFTER difference_at_close,
      ADD closing_denominations JSON NULL AFTER closing_reason,
      ADD closing_idempotency_key VARCHAR(128) NULL AFTER opening_idempotency_key,
      ADD closing_request_fingerprint CHAR(64) NULL AFTER request_fingerprint,
      ADD UNIQUE KEY uq_cash_register_shifts_closing_idempotency
        (tenant_id, closing_idempotency_key),
      ADD CONSTRAINT fk_cash_register_shifts_closed_user_tenant
        FOREIGN KEY (closed_by_user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      UPDATE cash_register_shifts crs
      INNER JOIN (
        SELECT shift_totals.id,
          shift_totals.opening_amount + shift_totals.cash_sales
            + shift_totals.movements_net AS expected_cash
        FROM (
          SELECT legacy.id, legacy.opening_amount,
            COALESCE((SELECT SUM(sp.amount_applied) FROM sales s
              INNER JOIN sale_payments sp
                ON sp.sale_id = s.id AND sp.tenant_id = s.tenant_id
              WHERE s.tenant_id = legacy.tenant_id
                AND s.cash_register_shift_id = legacy.id
                AND s.status = 'COMPLETED'), 0) AS cash_sales,
            COALESCE((SELECT SUM(CASE
              WHEN cm.type = 'INCOME' THEN cm.amount
              WHEN cm.type = 'WITHDRAWAL' THEN -cm.amount
              WHEN original.type = 'INCOME' THEN -cm.amount
              ELSE cm.amount END)
              FROM cash_register_movements cm
              LEFT JOIN cash_register_movements original
                ON original.id = cm.reversal_of_id
                AND original.tenant_id = cm.tenant_id
              WHERE cm.tenant_id = legacy.tenant_id
                AND cm.cash_register_shift_id = legacy.id), 0) AS movements_net
          FROM cash_register_shifts legacy
          WHERE legacy.status = 'CLOSED'
        ) shift_totals
      ) totals ON totals.id = crs.id
      SET crs.closed_by_user_id = crs.opened_by_user_id,
          crs.closing_counted_amount = totals.expected_cash,
          crs.expected_cash_at_close = totals.expected_cash,
          crs.difference_at_close = 0,
          crs.closing_reason = 'Cierre migrado sin diferencia registrada',
          crs.closing_denominations = JSON_ARRAY(),
          crs.closing_idempotency_key = CONCAT('legacy-close-', crs.id),
          crs.closing_request_fingerprint = SHA2(CONCAT('legacy-close:', crs.id), 256)
      WHERE crs.status = 'CLOSED'
    `);
    await queryRunner.query(`
      ALTER TABLE cash_register_shifts
      DROP CHECK ck_cash_register_shifts_closed,
      ADD CONSTRAINT ck_cash_register_shifts_closed CHECK (
        (status = 'OPEN' AND closed_at IS NULL AND closed_by_user_id IS NULL
          AND closing_counted_amount IS NULL AND expected_cash_at_close IS NULL
          AND difference_at_close IS NULL AND closing_idempotency_key IS NULL
          AND closing_request_fingerprint IS NULL) OR
        (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
          AND closing_counted_amount IS NOT NULL AND expected_cash_at_close IS NOT NULL
          AND difference_at_close IS NOT NULL AND closing_idempotency_key IS NOT NULL
          AND closing_request_fingerprint IS NOT NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE cash_register_shifts
      DROP CHECK ck_cash_register_shifts_closed,
      ADD CONSTRAINT ck_cash_register_shifts_closed CHECK (
        (status = 'OPEN' AND closed_at IS NULL) OR
        (status = 'CLOSED' AND closed_at IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE cash_register_shifts
      DROP FOREIGN KEY fk_cash_register_shifts_closed_user_tenant,
      DROP KEY uq_cash_register_shifts_closing_idempotency,
      DROP COLUMN closing_request_fingerprint,
      DROP COLUMN closing_idempotency_key,
      DROP COLUMN closing_denominations,
      DROP COLUMN closing_reason,
      DROP COLUMN difference_at_close,
      DROP COLUMN expected_cash_at_close,
      DROP COLUMN closing_counted_amount,
      DROP COLUMN closed_by_user_id
    `);
  }
}

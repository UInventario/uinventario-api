import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNoncashSalePayments1787972400000 implements MigrationInterface {
  name = 'AddNoncashSalePayments1787972400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sale_payments
      DROP CHECK ck_sale_payments_method,
      DROP CHECK ck_sale_payments_amounts,
      ADD provider VARCHAR(40) NOT NULL DEFAULT 'CASH' AFTER method,
      ADD external_reference VARCHAR(120) NULL AFTER provider,
      ADD provider_reference VARCHAR(120) NULL AFTER external_reference,
      ADD authorization_code VARCHAR(80) NULL AFTER provider_reference,
      ADD authorization_status VARCHAR(20) NOT NULL DEFAULT 'APPROVED' AFTER authorization_code,
      ADD UNIQUE KEY uq_sale_payments_external_reference (tenant_id, method, external_reference),
      ADD CONSTRAINT ck_sale_payments_method CHECK (method IN ('CASH', 'CARD', 'TRANSFER', 'VOUCHER')),
      ADD CONSTRAINT ck_sale_payments_authorization_status CHECK (authorization_status = 'APPROVED'),
      ADD CONSTRAINT ck_sale_payments_amounts CHECK (
        (method = 'CASH' AND amount_received >= amount_applied AND amount_applied > 0
          AND change_amount = amount_received - amount_applied AND external_reference IS NULL)
        OR
        (method <> 'CASH' AND amount_received = amount_applied AND amount_applied > 0
          AND change_amount = 0 AND external_reference IS NOT NULL
          AND provider_reference IS NOT NULL AND authorization_code IS NOT NULL)
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE sale_payments
      DROP CHECK ck_sale_payments_amounts,
      DROP CHECK ck_sale_payments_authorization_status,
      DROP CHECK ck_sale_payments_method,
      DROP INDEX uq_sale_payments_external_reference,
      DROP COLUMN authorization_status,
      DROP COLUMN authorization_code,
      DROP COLUMN provider_reference,
      DROP COLUMN external_reference,
      DROP COLUMN provider,
      ADD CONSTRAINT ck_sale_payments_method CHECK (method IN ('CASH')),
      ADD CONSTRAINT ck_sale_payments_amounts CHECK (
        amount_received >= amount_applied AND amount_applied > 0 AND change_amount >= 0
      )`);
  }
}

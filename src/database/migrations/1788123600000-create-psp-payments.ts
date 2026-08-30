import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePspPayments1788123600000 implements MigrationInterface {
  name = 'CreatePspPayments1788123600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE psp_payments (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        provider VARCHAR(32) NOT NULL, adapter_version VARCHAR(16) NOT NULL,
        provider_reference VARCHAR(100) NOT NULL,
        merchant_reference VARCHAR(100) NOT NULL,
        amount DECIMAL(14,2) NOT NULL, refunded_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
        currency CHAR(3) NOT NULL, status VARCHAR(24) NOT NULL,
        scenario VARCHAR(16) NOT NULL, error_code VARCHAR(80) NULL,
        create_idempotency_key VARCHAR(128) NOT NULL,
        request_fingerprint CHAR(64) NOT NULL,
        webhook_token_hash CHAR(64) NOT NULL,
        correlation_id VARCHAR(128) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_psp_payment_tenant_id (id, tenant_id),
        UNIQUE KEY uq_psp_payment_idempotency (tenant_id, create_idempotency_key),
        UNIQUE KEY uq_psp_payment_merchant (tenant_id, provider, merchant_reference),
        UNIQUE KEY uq_psp_payment_provider (tenant_id, provider, provider_reference),
        KEY ix_psp_payment_status (tenant_id, status, updated_at, id),
        CONSTRAINT fk_psp_payment_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_psp_payment_user FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_psp_payment_amount CHECK
          (amount > 0 AND refunded_amount >= 0 AND refunded_amount <= amount),
        CONSTRAINT ck_psp_payment_status CHECK (status IN
          ('REQUIRES_CONFIRMATION', 'AUTHORIZED', 'CAPTURED', 'INDETERMINATE',
           'DECLINED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
        CONSTRAINT ck_psp_payment_scenario CHECK (scenario IN ('SUCCESS', 'DECLINE', 'TIMEOUT'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE psp_payment_actions (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        payment_id CHAR(36) NOT NULL, action VARCHAR(16) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        result JSON NOT NULL, correlation_id VARCHAR(128) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_psp_action_idempotency (tenant_id, idempotency_key),
        KEY ix_psp_action_payment (tenant_id, payment_id, created_at),
        CONSTRAINT fk_psp_action_payment FOREIGN KEY (payment_id, tenant_id)
          REFERENCES psp_payments(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_psp_action_type CHECK (action IN ('CONFIRM', 'CAPTURE', 'QUERY', 'REFUND'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE psp_webhook_events (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        payment_id CHAR(36) NOT NULL, provider VARCHAR(32) NOT NULL,
        event_id VARCHAR(128) NOT NULL, event_fingerprint CHAR(64) NOT NULL,
        event_status VARCHAR(24) NOT NULL, ignored_out_of_order BOOLEAN NOT NULL,
        occurred_at DATETIME(6) NOT NULL,
        received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_psp_webhook_event (tenant_id, provider, event_id),
        KEY ix_psp_webhook_payment (tenant_id, payment_id, received_at),
        CONSTRAINT fk_psp_webhook_payment FOREIGN KEY (payment_id, tenant_id)
          REFERENCES psp_payments(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_psp_webhook_status CHECK
          (event_status IN ('AUTHORIZED', 'CAPTURED', 'DECLINED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE psp_webhook_events');
    await queryRunner.query('DROP TABLE psp_payment_actions');
    await queryRunner.query('DROP TABLE psp_payments');
  }
}

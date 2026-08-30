import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWhatsappIntegration1788134400000 implements MigrationInterface {
  name = 'CreateWhatsappIntegration1788134400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE external_adapter_configs
      DROP CHECK ck_external_adapter_configs_capability,
      ADD CONSTRAINT ck_external_adapter_configs_capability CHECK (
        capability IN ('NOTIFICATION_EMAIL', 'NOTIFICATION_PUSH', 'NOTIFICATION_WHATSAPP')
      )
    `);
    await queryRunner.query(`
      ALTER TABLE external_adapter_executions
      DROP CHECK ck_external_adapter_executions_capability,
      ADD CONSTRAINT ck_external_adapter_executions_capability CHECK (
        capability IN ('NOTIFICATION_EMAIL', 'NOTIFICATION_PUSH', 'NOTIFICATION_WHATSAPP')
      )
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO external_adapter_configs
        (id, tenant_id, capability, country_code, provider_key,
         adapter_version, enabled, timeout_ms, max_attempts)
      SELECT UUID(), id, 'NOTIFICATION_WHATSAPP', COALESCE(country_code, 'MX'),
             'SIMULATOR', '1', TRUE, 1000, 2
      FROM tenants
    `);
    await queryRunner.query(`
      CREATE TABLE customer_whatsapp_consents (
        tenant_id CHAR(36) NOT NULL, customer_id CHAR(36) NOT NULL,
        status VARCHAR(16) NOT NULL, changed_by_user_id CHAR(36) NOT NULL,
        changed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, customer_id),
        CONSTRAINT fk_whatsapp_consent_customer FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_whatsapp_consent_user FOREIGN KEY (changed_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_whatsapp_consent_status CHECK (status IN ('OPTED_IN', 'OPTED_OUT'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE whatsapp_messages (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, customer_id CHAR(36) NOT NULL,
        template_key VARCHAR(48) NOT NULL, template_version VARCHAR(16) NOT NULL,
        reference_key VARCHAR(120) NULL, recipient_hash CHAR(64) NOT NULL,
        recipient_last4 CHAR(4) NOT NULL, status VARCHAR(20) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        external_execution_id CHAR(36) NULL, provider_reference VARCHAR(120) NULL,
        webhook_token_hash CHAR(64) NOT NULL, error_code VARCHAR(80) NULL,
        last_event_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_whatsapp_message_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_whatsapp_provider_reference (tenant_id, provider_reference),
        KEY ix_whatsapp_message_rate (tenant_id, customer_id, created_at),
        CONSTRAINT fk_whatsapp_message_customer FOREIGN KEY (customer_id, tenant_id)
          REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_whatsapp_message_execution FOREIGN KEY (external_execution_id)
          REFERENCES external_adapter_executions(id) ON DELETE RESTRICT,
        CONSTRAINT ck_whatsapp_message_template CHECK (
          template_key IN ('WHATSAPP_SALE_RECEIPT', 'WHATSAPP_ORDER_STATUS',
            'WHATSAPP_OPERATIONAL_NOTICE') AND template_version = '1'
        ),
        CONSTRAINT ck_whatsapp_message_status CHECK (
          status IN ('PENDING', 'SENT', 'DELIVERED', 'READ', 'REJECTED', 'FAILED', 'TIMED_OUT')
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE whatsapp_webhook_events (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, message_id CHAR(36) NOT NULL,
        provider_event_id VARCHAR(128) NOT NULL, status VARCHAR(20) NOT NULL,
        occurred_at DATETIME(6) NOT NULL, ignored_out_of_order BOOLEAN NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_whatsapp_webhook_event (tenant_id, provider_event_id),
        KEY ix_whatsapp_webhook_message (tenant_id, message_id, occurred_at),
        CONSTRAINT fk_whatsapp_webhook_message FOREIGN KEY (message_id)
          REFERENCES whatsapp_messages(id) ON DELETE RESTRICT,
        CONSTRAINT ck_whatsapp_webhook_status CHECK (
          status IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE whatsapp_webhook_events');
    await queryRunner.query('DROP TABLE whatsapp_messages');
    await queryRunner.query('DROP TABLE customer_whatsapp_consents');
    await queryRunner.query(
      "DELETE FROM external_adapter_executions WHERE capability = 'NOTIFICATION_WHATSAPP'",
    );
    await queryRunner.query(
      "DELETE FROM external_adapter_configs WHERE capability = 'NOTIFICATION_WHATSAPP'",
    );
    await queryRunner.query(`
      ALTER TABLE external_adapter_executions
      DROP CHECK ck_external_adapter_executions_capability,
      ADD CONSTRAINT ck_external_adapter_executions_capability CHECK (
        capability IN ('NOTIFICATION_EMAIL', 'NOTIFICATION_PUSH')
      )
    `);
    await queryRunner.query(`
      ALTER TABLE external_adapter_configs
      DROP CHECK ck_external_adapter_configs_capability,
      ADD CONSTRAINT ck_external_adapter_configs_capability CHECK (
        capability IN ('NOTIFICATION_EMAIL', 'NOTIFICATION_PUSH')
      )
    `);
  }
}

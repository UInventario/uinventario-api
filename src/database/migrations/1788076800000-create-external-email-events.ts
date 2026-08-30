import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateExternalEmailEvents1788076800000 implements MigrationInterface {
  name = 'CreateExternalEmailEvents1788076800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE external_email_events (
        webhook_event_id VARCHAR(128) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        provider_key VARCHAR(64) NOT NULL,
        provider_reference VARCHAR(128) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        error_code VARCHAR(64) NULL,
        occurred_at DATETIME(6) NOT NULL,
        received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (webhook_event_id),
        KEY ix_external_email_events_tenant_time (tenant_id, occurred_at),
        KEY ix_external_email_events_provider_reference
          (provider_key, provider_reference),
        CONSTRAINT fk_external_email_events_tenant
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT ck_external_email_events_type CHECK (
          event_type IN (
            'SENT', 'DELIVERED', 'DELIVERY_DELAYED', 'BOUNCED',
            'FAILED', 'SUPPRESSED', 'COMPLAINED'
          )
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE external_email_events');
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CompleteCarrierIntegration1788130800000 implements MigrationInterface {
  name = 'CompleteCarrierIntegration1788130800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE customer_order_fulfillments
        ADD COLUMN carrier_version VARCHAR(16) NULL AFTER carrier_name,
        ADD COLUMN label_format VARCHAR(16) NULL AFTER tracking_reference,
        ADD COLUMN label_payload TEXT NULL AFTER label_format,
        ADD COLUMN tracking_status VARCHAR(24) NULL AFTER label_payload,
        ADD COLUMN latest_event_sequence INT UNSIGNED NOT NULL DEFAULT 0 AFTER tracking_status,
        ADD COLUMN latest_event_at DATETIME(6) NULL AFTER latest_event_sequence,
        ADD COLUMN manual_action_required BOOLEAN NOT NULL DEFAULT FALSE AFTER latest_event_at,
        ADD CONSTRAINT ck_customer_order_tracking_status CHECK (
          tracking_status IS NULL OR tracking_status IN (
            'LABEL_READY', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
            'DELIVERED', 'EXCEPTION', 'CANCELLED'
          )
        )
    `);
    await queryRunner.query(`
      UPDATE customer_order_fulfillments
      SET carrier_version = '1'
      WHERE carrier_code IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE customer_order_carrier_events (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        order_id CHAR(36) NOT NULL, provider_event_id VARCHAR(128) NOT NULL,
        tracking_reference VARCHAR(120) NOT NULL,
        source VARCHAR(16) NOT NULL, status VARCHAR(24) NOT NULL,
        sequence_number INT UNSIGNED NOT NULL, occurred_at DATETIME(6) NOT NULL,
        applied BOOLEAN NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_order_carrier_event (tenant_id, provider_event_id),
        KEY ix_customer_order_carrier_timeline (tenant_id, order_id, sequence_number),
        CONSTRAINT fk_customer_order_carrier_event_order
          FOREIGN KEY (order_id, tenant_id)
          REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_order_carrier_event_source
          CHECK (source IN ('WEBHOOK', 'POLLING')),
        CONSTRAINT ck_customer_order_carrier_event_status CHECK (
          status IN ('LABEL_READY', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
            'DELIVERED', 'EXCEPTION', 'CANCELLED')
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_order_shipping_actions (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        order_id CHAR(36) NOT NULL, action VARCHAR(16) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        result JSON NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_customer_order_shipping_action (tenant_id, idempotency_key),
        KEY ix_customer_order_shipping_order (tenant_id, order_id, created_at),
        CONSTRAINT fk_customer_order_shipping_action_order
          FOREIGN KEY (order_id, tenant_id)
          REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_order_shipping_action
          CHECK (action IN ('CANCEL', 'POLL'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE customer_order_shipping_actions');
    await queryRunner.query('DROP TABLE customer_order_carrier_events');
    await queryRunner.query(`
      ALTER TABLE customer_order_fulfillments
        DROP CHECK ck_customer_order_tracking_status,
        DROP COLUMN manual_action_required,
        DROP COLUMN latest_event_at,
        DROP COLUMN latest_event_sequence,
        DROP COLUMN tracking_status,
        DROP COLUMN label_payload,
        DROP COLUMN label_format,
        DROP COLUMN carrier_version
    `);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOfflineCommandInbox1787950800000 implements MigrationInterface {
  name = 'CreateOfflineCommandInbox1787950800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE offline_device_sequences (
      tenant_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, device_id CHAR(36) NOT NULL,
      last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      PRIMARY KEY (tenant_id, user_id, device_id),
      CONSTRAINT fk_offline_device_sequences_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_offline_device_sequences_user_tenant FOREIGN KEY (user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await queryRunner.query(`CREATE TABLE offline_commands (
      command_id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL, device_id CHAR(36) NOT NULL,
      sequence BIGINT UNSIGNED NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
      kind VARCHAR(40) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL, result_json JSON NULL, error_json JSON NULL,
      device_created_at DATETIME(6) NOT NULL,
      received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      completed_at DATETIME(6) NULL,
      PRIMARY KEY (command_id),
      UNIQUE KEY uq_offline_commands_sequence (tenant_id, user_id, device_id, sequence),
      UNIQUE KEY uq_offline_commands_idempotency (tenant_id, user_id, device_id, idempotency_key),
      KEY ix_offline_commands_status (tenant_id, status, received_at),
      CONSTRAINT fk_offline_commands_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_offline_commands_user_tenant FOREIGN KEY (user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE offline_commands');
    await queryRunner.query('DROP TABLE offline_device_sequences');
  }
}

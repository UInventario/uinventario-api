import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOfflineDevices1787958000000 implements MigrationInterface {
  name = 'CreateOfflineDevices1787958000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE offline_devices (
      tenant_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, device_id CHAR(36) NOT NULL,
      first_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      revoked_at DATETIME(6) NULL,
      PRIMARY KEY (tenant_id, user_id, device_id),
      KEY ix_offline_devices_user (tenant_id, user_id, last_seen_at),
      CONSTRAINT fk_offline_devices_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_offline_devices_user_tenant FOREIGN KEY (user_id, tenant_id)
        REFERENCES users(id, tenant_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE offline_devices');
  }
}

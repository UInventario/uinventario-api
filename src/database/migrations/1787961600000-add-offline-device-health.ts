import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOfflineDeviceHealth1787961600000 implements MigrationInterface {
  name = 'AddOfflineDeviceHealth1787961600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE offline_devices
      ADD bootstrap_required_at DATETIME(6) NULL AFTER revoked_at,
      ADD last_sync_at DATETIME(6) NULL AFTER last_seen_at,
      ADD last_cursor_hash CHAR(64) NULL AFTER last_sync_at,
      ADD last_correlation_id VARCHAR(128) NULL AFTER last_cursor_hash`);
    await queryRunner.query(`ALTER TABLE offline_commands
      ADD replay_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER completed_at`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE offline_commands DROP COLUMN replay_count',
    );
    await queryRunner.query(`ALTER TABLE offline_devices
      DROP COLUMN last_correlation_id,
      DROP COLUMN last_cursor_hash,
      DROP COLUMN last_sync_at,
      DROP COLUMN bootstrap_required_at`);
  }
}

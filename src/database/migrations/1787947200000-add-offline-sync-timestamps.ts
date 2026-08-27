import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOfflineSyncTimestamps1787947200000 implements MigrationInterface {
  name = 'AddOfflineSyncTimestamps1787947200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE offline_sync_tombstones (
      change_id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
      entity_kind VARCHAR(40) NOT NULL, entity_id CHAR(36) NOT NULL,
      payload JSON NOT NULL,
      occurred_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (change_id),
      KEY ix_offline_sync_tombstones_pull (tenant_id, occurred_at, change_id),
      CONSTRAINT fk_offline_sync_tombstones_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    for (const table of [
      'branches',
      'warehouses',
      'locations',
      'cash_registers',
    ]) {
      await queryRunner.query(`ALTER TABLE ${table}
        ADD COLUMN updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        ADD INDEX ix_${table}_offline_sync (tenant_id, updated_at, id)`);
      await queryRunner.query(`UPDATE ${table} SET updated_at = created_at`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'cash_registers',
      'locations',
      'warehouses',
      'branches',
    ]) {
      if (await queryRunner.hasColumn(table, 'updated_at')) {
        await queryRunner.query(
          `ALTER TABLE ${table} DROP INDEX ix_${table}_offline_sync, DROP COLUMN updated_at`,
        );
      }
    }
    if (await queryRunner.hasTable('offline_sync_tombstones')) {
      await queryRunner.query('DROP TABLE offline_sync_tombstones');
    }
  }
}

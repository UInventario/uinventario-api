import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSessions1787821200000 implements MigrationInterface {
  name = 'CreateSessions1787821200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenants
      ADD onboarding_completed_at DATETIME(6) NULL
    `);
    await queryRunner.query(`
      CREATE TABLE sessions (
        id CHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        user_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        expires_at DATETIME(6) NOT NULL,
        revoked_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_sessions_token_hash (token_hash),
        KEY ix_sessions_user (user_id),
        KEY ix_sessions_tenant (tenant_id),
        KEY ix_sessions_expiry (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE sessions');
    await queryRunner.query(
      'ALTER TABLE tenants DROP COLUMN onboarding_completed_at',
    );
  }
}

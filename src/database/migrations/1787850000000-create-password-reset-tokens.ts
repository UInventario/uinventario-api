import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePasswordResetTokens1787850000000 implements MigrationInterface {
  name = 'CreatePasswordResetTokens1787850000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE password_reset_tokens (
        id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL, expires_at DATETIME(6) NOT NULL,
        used_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_password_reset_token_hash (token_hash),
        KEY ix_password_reset_user_created (user_id, created_at),
        CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE password_reset_tokens');
  }
}

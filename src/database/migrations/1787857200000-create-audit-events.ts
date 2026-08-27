import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuditEvents1787857200000 implements MigrationInterface {
  name = 'CreateAuditEvents1787857200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE audit_events (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        actor_user_id CHAR(36) NOT NULL,
        action VARCHAR(64) NOT NULL,
        entity_type VARCHAR(48) NOT NULL,
        entity_id CHAR(36) NOT NULL,
        correlation_id VARCHAR(128) NOT NULL,
        event_key VARCHAR(255) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_audit_events_event_key (event_key),
        KEY ix_audit_events_tenant_created (tenant_id, created_at, id),
        KEY ix_audit_events_actor (actor_user_id),
        CONSTRAINT fk_audit_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_audit_events_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE audit_events');
  }
}

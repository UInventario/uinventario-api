import { createHash } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

interface ExistingAuditEvent {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  correlation_id: string;
  before_data: string | Record<string, unknown> | null;
  after_data: string | Record<string, unknown> | null;
}

const SENSITIVE_KEY =
  /password|passphrase|secret|token|authorization|cookie|api.?key|private.?key|connection.?string/i;

export class ConsolidateAuditIntegrity1787907600000 implements MigrationInterface {
  name = 'ConsolidateAuditIntegrity1787907600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'AUDIT_VIEW', 'AUDIT_EXPORT',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
    await queryRunner.query(`
      INSERT IGNORE INTO role_permissions (role_id, tenant_id, permission)
      SELECT r.id, r.tenant_id, permissions.permission
      FROM roles r
      CROSS JOIN (
        SELECT 'AUDIT_VIEW' AS permission UNION ALL SELECT 'AUDIT_EXPORT'
      ) permissions
      WHERE r.code = 'ADMIN'
    `);
    await queryRunner.query(`
      CREATE TABLE audit_chain_heads (
        tenant_id CHAR(36) NOT NULL,
        last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
        last_hash CHAR(64) NOT NULL,
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id),
        CONSTRAINT fk_audit_chain_heads_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE audit_events
      ADD impersonator_user_id CHAR(36) NULL AFTER actor_user_id,
      ADD origin VARCHAR(32) NOT NULL DEFAULT 'APPLICATION' AFTER correlation_id,
      ADD sequence_number BIGINT UNSIGNED NULL AFTER event_key,
      ADD payload_hash CHAR(64) NULL AFTER sequence_number,
      ADD previous_hash CHAR(64) NULL AFTER payload_hash,
      ADD integrity_hash CHAR(64) NULL AFTER previous_hash,
      ADD retention_until DATETIME(6) NULL AFTER integrity_hash,
      ADD KEY ix_audit_events_impersonator (impersonator_user_id),
      ADD CONSTRAINT fk_audit_events_impersonator FOREIGN KEY (impersonator_user_id)
        REFERENCES users(id) ON DELETE RESTRICT
    `);

    const events = (await queryRunner.query(`
      SELECT id, tenant_id, actor_user_id, action, entity_type, entity_id,
             correlation_id, before_data, after_data
      FROM audit_events ORDER BY tenant_id, created_at, id
    `)) as ExistingAuditEvent[];
    let tenantId: string | null = null;
    let sequence = 0;
    let previousHash = '0'.repeat(64);
    for (const event of events) {
      if (event.tenant_id !== tenantId) {
        tenantId = event.tenant_id;
        sequence = 0;
        previousHash = '0'.repeat(64);
      }
      sequence += 1;
      const before = this.redactRecord(this.json(event.before_data));
      const after = this.redactRecord(this.json(event.after_data));
      const payloadHash = this.payloadHash({
        id: event.id,
        tenantId: event.tenant_id,
        actorUserId: event.actor_user_id,
        impersonatorUserId: null,
        action: event.action,
        entityType: event.entity_type,
        entityId: event.entity_id,
        correlationId: event.correlation_id,
        origin: 'APPLICATION',
        before,
        after,
      });
      const integrityHash = this.sha256(
        `${previousHash}:${sequence}:${payloadHash}`,
      );
      await queryRunner.query(
        `UPDATE audit_events
         SET sequence_number = ?, payload_hash = ?, previous_hash = ?,
             integrity_hash = ?, retention_until = DATE_ADD(created_at, INTERVAL 365 DAY),
             before_data = ?, after_data = ?
         WHERE id = ?`,
        [
          sequence,
          payloadHash,
          previousHash,
          integrityHash,
          before ? this.stableStringify(before) : null,
          after ? this.stableStringify(after) : null,
          event.id,
        ],
      );
      previousHash = integrityHash;
    }
    const tenants = (await queryRunner.query(`
      SELECT ae.tenant_id, ae.sequence_number AS last_sequence,
             ae.integrity_hash AS last_hash
      FROM audit_events ae
      INNER JOIN (
        SELECT tenant_id, MAX(sequence_number) AS last_sequence
        FROM audit_events GROUP BY tenant_id
      ) latest ON latest.tenant_id = ae.tenant_id
        AND latest.last_sequence = ae.sequence_number
    `)) as Array<{
      tenant_id: string;
      last_sequence: number | string;
      last_hash: string;
    }>;
    for (const tenant of tenants) {
      await queryRunner.query(
        `INSERT INTO audit_chain_heads (tenant_id, last_sequence, last_hash)
         VALUES (?, ?, ?)`,
        [tenant.tenant_id, tenant.last_sequence, tenant.last_hash],
      );
    }
    await queryRunner.query(`
      ALTER TABLE audit_events
      MODIFY sequence_number BIGINT UNSIGNED NOT NULL,
      MODIFY payload_hash CHAR(64) NOT NULL,
      MODIFY previous_hash CHAR(64) NOT NULL,
      MODIFY integrity_hash CHAR(64) NOT NULL,
      MODIFY retention_until DATETIME(6) NOT NULL,
      ADD UNIQUE KEY uq_audit_events_tenant_sequence (tenant_id, sequence_number),
      ADD KEY ix_audit_events_tenant_action (tenant_id, action, created_at, id),
      ADD KEY ix_audit_events_tenant_entity (tenant_id, entity_type, entity_id, created_at),
      ADD KEY ix_audit_events_tenant_correlation (tenant_id, correlation_id, created_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE audit_events
      DROP KEY ix_audit_events_tenant_correlation,
      DROP KEY ix_audit_events_tenant_entity,
      DROP KEY ix_audit_events_tenant_action,
      DROP KEY uq_audit_events_tenant_sequence,
      DROP FOREIGN KEY fk_audit_events_impersonator,
      DROP KEY ix_audit_events_impersonator,
      DROP COLUMN retention_until,
      DROP COLUMN integrity_hash,
      DROP COLUMN previous_hash,
      DROP COLUMN payload_hash,
      DROP COLUMN sequence_number,
      DROP COLUMN origin,
      DROP COLUMN impersonator_user_id
    `);
    await queryRunner.query('DROP TABLE audit_chain_heads');
    await queryRunner.query(
      "DELETE FROM role_permissions WHERE permission IN ('AUDIT_VIEW', 'AUDIT_EXPORT')",
    );
    await queryRunner.query(`
      ALTER TABLE role_permissions
      DROP CHECK ck_role_permissions_permission,
      ADD CONSTRAINT ck_role_permissions_permission CHECK (permission IN (
        'TENANT_MANAGE', 'PRODUCTS_MANAGE', 'SALES_MANAGE', 'SALES_VOID',
        'SALES_DISCOUNT', 'SALE_REPRINT', 'CASH_REGISTER_OPEN',
        'CASH_REGISTER_CLOSE', 'CASH_REGISTER_MOVE', 'ACCESS_MANAGE',
        'INVENTORY_VIEW', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
        'INVENTORY_COUNT', 'INVENTORY_APPROVE'
      ))
    `);
  }

  private payloadHash(input: Record<string, unknown>): string {
    return this.sha256(this.stableStringify(input));
  }

  private redactRecord(
    value: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    return value ? (this.redact(value) as Record<string, unknown>) : null;
  }

  private redact(value: unknown, key = ''): unknown {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .map(([childKey, child]) => [childKey, this.redact(child, childKey)]),
      );
    }
    if (typeof value === 'string') {
      return value
        .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/[^:/\s]+:)[^@/\s]+@/gi, '$1[REDACTED]@')
        .replace(
          /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
          '[REDACTED PRIVATE KEY]',
        );
    }
    return value;
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private json(
    value: string | Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!value) return null;
    return typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : value;
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object')
      return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`,
      )
      .join(',')}}`;
  }
}

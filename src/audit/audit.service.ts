import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { ListAuditEventsDto } from './dto/list-audit-events.dto';

export interface RecordAuditEvent {
  tenantId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  correlationId: string;
  deduplicate?: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly dataSource: DataSource) {}

  async record(input: RecordAuditEvent): Promise<void> {
    try {
      await this.insert(this.dataSource.manager, input);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ER_DUP_ENTRY') return;
      this.logger.error(
        JSON.stringify({
          event: 'audit_write_failed',
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: input.action,
          correlationId: input.correlationId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }

  async recordInTransaction(
    manager: EntityManager,
    input: RecordAuditEvent,
  ): Promise<void> {
    await this.insert(manager, input);
  }

  private async insert(
    manager: EntityManager,
    input: RecordAuditEvent,
  ): Promise<void> {
    const eventKey = createHash('sha256')
      .update(
        input.deduplicate
          ? `${input.tenantId}:${input.action}:${input.entityType}:${input.entityId}`
          : `${input.tenantId}:${input.action}:${input.entityType}:${input.entityId}:${input.correlationId}`,
      )
      .digest('hex');
    await manager.query(
      `INSERT INTO audit_events
          (id, tenant_id, actor_user_id, action, entity_type, entity_id, correlation_id,
           event_key, before_data, after_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.tenantId,
        input.actorUserId,
        input.action,
        input.entityType,
        input.entityId,
        input.correlationId,
        eventKey,
        input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null,
      ],
    );
  }

  async list(tenantId: string, query: ListAuditEventsDto) {
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [count]] = await Promise.all([
      this.dataSource.query<
        Array<{
          id: string;
          action: string;
          entity_type: string;
          entity_id: string;
          correlation_id: string;
          created_at: Date | string;
          actor_id: string;
          actor_email: string;
          before_data: string | Record<string, unknown> | null;
          after_data: string | Record<string, unknown> | null;
        }>
      >(
        `SELECT ae.id, ae.action, ae.entity_type, ae.entity_id, ae.correlation_id,
                ae.created_at, ae.before_data, ae.after_data,
                u.id AS actor_id, u.email AS actor_email
         FROM audit_events ae
         INNER JOIN users u ON u.id = ae.actor_user_id AND u.tenant_id = ae.tenant_id
         WHERE ae.tenant_id = ?
         ORDER BY ae.created_at DESC, ae.id DESC
         LIMIT ? OFFSET ?`,
        [tenantId, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        'SELECT COUNT(*) AS total FROM audit_events WHERE tenant_id = ?',
        [tenantId],
      ),
    ]);
    const total = Number(count.total);
    return {
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        correlationId: row.correlation_id,
        createdAt: new Date(row.created_at).toISOString(),
        actor: { id: row.actor_id, email: row.actor_email },
        before: this.parseJson(row.before_data),
        after: this.parseJson(row.after_data),
      })),
      meta: {
        apiVersion: '1' as const,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      },
    };
  }

  private parseJson(
    value: string | Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!value) return null;
    return typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : value;
  }
}

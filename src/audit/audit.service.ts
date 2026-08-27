import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly dataSource: DataSource) {}

  async record(input: RecordAuditEvent): Promise<void> {
    const eventKey = createHash('sha256')
      .update(
        input.deduplicate
          ? `${input.tenantId}:${input.action}:${input.entityType}:${input.entityId}`
          : `${input.tenantId}:${input.action}:${input.entityType}:${input.entityId}:${input.correlationId}`,
      )
      .digest('hex');
    try {
      await this.dataSource.query(
        `INSERT INTO audit_events
          (id, tenant_id, actor_user_id, action, entity_type, entity_id, correlation_id, event_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.tenantId,
          input.actorUserId,
          input.action,
          input.entityType,
          input.entityId,
          input.correlationId,
          eventKey,
        ],
      );
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
        }>
      >(
        `SELECT ae.id, ae.action, ae.entity_type, ae.entity_id, ae.correlation_id,
                ae.created_at, u.id AS actor_id, u.email AS actor_email
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
}

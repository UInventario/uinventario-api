import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { ListAuditEventsDto } from './dto/list-audit-events.dto';
import { StructuredTelemetryService } from '../observability/structured-telemetry.service';

export type AuditOrigin =
  'APPLICATION' | 'ADMIN_CONSOLE' | 'SYSTEM' | 'INTEGRATION';

export interface RecordAuditEvent {
  tenantId: string;
  actorUserId: string;
  impersonatorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  correlationId: string;
  origin?: AuditOrigin;
  deduplicate?: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  sequence_number: number | string;
  action: string;
  entity_type: string;
  entity_id: string;
  correlation_id: string;
  origin: AuditOrigin;
  payload_hash: string;
  previous_hash: string;
  integrity_hash: string;
  retention_until: Date | string;
  created_at: Date | string;
  actor_id: string;
  actor_email: string;
  impersonator_id: string | null;
  impersonator_email: string | null;
  successor_previous_hash: string | null;
  chain_last_sequence: number | string;
  chain_last_hash: string;
  before_data: string | Record<string, unknown> | null;
  after_data: string | Record<string, unknown> | null;
}

export interface AuditEventData {
  id: string;
  tenantId: string;
  sequence: number;
  action: string;
  entityType: string;
  entityId: string;
  correlationId: string;
  origin: AuditOrigin;
  createdAt: string;
  retentionUntil: string;
  actor: { id: string; email: string };
  impersonator: { id: string; email: string } | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  integrity: { valid: boolean; hash: string; previousHash: string };
}

const RETENTION_DAYS = 365;
const GENESIS_HASH = '0'.repeat(64);
const SENSITIVE_KEY =
  /password|passphrase|secret|token|authorization|cookie|api.?key|private.?key|connection.?string/i;

@Injectable()
export class AuditService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly telemetry: StructuredTelemetryService,
  ) {}

  async record(input: RecordAuditEvent): Promise<void> {
    try {
      await this.dataSource.transaction((manager) =>
        this.insert(manager, input),
      );
    } catch (error) {
      if (this.isDuplicate(error)) return;
      this.telemetry.emit({
        severity: 'ERROR',
        event: 'audit_write_failed',
        tenantRef: this.telemetry.tenantRef(input.tenantId),
        action: input.action,
        correlationId: input.correlationId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  async recordRequired(input: RecordAuditEvent): Promise<void> {
    await this.dataSource.transaction((manager) => this.insert(manager, input));
  }

  async recordInTransaction(
    manager: EntityManager,
    input: RecordAuditEvent,
  ): Promise<void> {
    await this.insert(manager, input);
  }

  async list(tenantId: string, query: ListAuditEventsDto) {
    this.validateDates(query);
    const { where, parameters } = this.filters(tenantId, query);
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [count]] = await Promise.all([
      this.queryRows(where, [...parameters, query.pageSize, offset]),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total
         FROM audit_events ae
         INNER JOIN users actor ON actor.id = ae.actor_user_id
           AND actor.tenant_id = ae.tenant_id
         LEFT JOIN users impersonator ON impersonator.id = ae.impersonator_user_id
           AND impersonator.tenant_id = ae.tenant_id
         WHERE ${where}`,
        parameters,
      ),
    ]);
    const data = rows.map((row) => this.toEvent(row));
    const total = Number(count.total);
    return {
      data,
      meta: {
        apiVersion: '1' as const,
        retention: {
          minimumDays: RETENTION_DAYS,
          policy: 'APPEND_ONLY' as const,
        },
        integrity: { valid: data.every((event) => event.integrity.valid) },
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      },
    };
  }

  async exportCsv(
    tenantId: string,
    query: ListAuditEventsDto,
  ): Promise<{ content: string; count: number }> {
    this.validateDates(query);
    const { where, parameters } = this.filters(tenantId, query);
    const rows = await this.queryRows(where, [...parameters, 10_000, 0]);
    const events = rows.map((row) => this.toEvent(row));
    const headers = [
      'sequence',
      'createdAt',
      'action',
      'entityType',
      'entityId',
      'actor',
      'impersonator',
      'origin',
      'correlationId',
      'integrityValid',
      'integrityHash',
      'before',
      'after',
      'retentionUntil',
    ];
    const lines = events.map((event) =>
      [
        event.sequence,
        event.createdAt,
        event.action,
        event.entityType,
        event.entityId,
        event.actor.email,
        event.impersonator?.email ?? '',
        event.origin,
        event.correlationId,
        event.integrity.valid,
        event.integrity.hash,
        event.before ? this.stableStringify(event.before) : '',
        event.after ? this.stableStringify(event.after) : '',
        event.retentionUntil,
      ]
        .map((value) => this.csvCell(String(value)))
        .join(','),
    );
    return {
      content: `\uFEFF${[headers.join(','), ...lines].join('\r\n')}\r\n`,
      count: events.length,
    };
  }

  filtersSnapshot(query: ListAuditEventsDto): Record<string, unknown> {
    return {
      ...(query.q ? { q: query.q } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo ? { dateTo: query.dateTo } : {}),
      page: query.page,
      pageSize: query.pageSize,
    };
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
      `INSERT INTO audit_chain_heads (tenant_id, last_sequence, last_hash)
       VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE tenant_id = tenant_id`,
      [input.tenantId, GENESIS_HASH],
    );
    const [head] = await manager.query<
      Array<{ last_sequence: number | string; last_hash: string }>
    >(
      `SELECT last_sequence, last_hash FROM audit_chain_heads
       WHERE tenant_id = ? FOR UPDATE`,
      [input.tenantId],
    );
    const sequence = BigInt(head.last_sequence) + 1n;
    const id = randomUUID();
    const origin = input.origin ?? 'APPLICATION';
    const before = input.before ? this.redactRecord(input.before) : null;
    const after = input.after ? this.redactRecord(input.after) : null;
    const payloadHash = this.payloadHash({
      id,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      impersonatorUserId: input.impersonatorUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      correlationId: input.correlationId,
      origin,
      before,
      after,
    });
    const integrityHash = this.sha256(
      `${head.last_hash}:${sequence}:${payloadHash}`,
    );
    await manager.query(
      `INSERT INTO audit_events
        (id, tenant_id, actor_user_id, impersonator_user_id, action, entity_type,
         entity_id, correlation_id, origin, event_key, sequence_number,
         payload_hash, previous_hash, integrity_hash, retention_until,
         before_data, after_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ${RETENTION_DAYS} DAY), ?, ?)`,
      [
        id,
        input.tenantId,
        input.actorUserId,
        input.impersonatorUserId ?? null,
        input.action,
        input.entityType,
        input.entityId,
        input.correlationId,
        origin,
        eventKey,
        sequence.toString(),
        payloadHash,
        head.last_hash,
        integrityHash,
        before ? this.stableStringify(before) : null,
        after ? this.stableStringify(after) : null,
      ],
    );
    await manager.query(
      `UPDATE audit_chain_heads SET last_sequence = ?, last_hash = ?
       WHERE tenant_id = ?`,
      [sequence.toString(), integrityHash, input.tenantId],
    );
  }

  private async queryRows(
    where: string,
    parameters: unknown[],
  ): Promise<AuditRow[]> {
    return this.dataSource.query<AuditRow[]>(
      `SELECT ae.id, ae.tenant_id, ae.sequence_number, ae.action,
              ae.entity_type, ae.entity_id, ae.correlation_id, ae.origin,
              ae.payload_hash, ae.previous_hash, ae.integrity_hash,
              ae.retention_until, ae.created_at, ae.before_data, ae.after_data,
              actor.id AS actor_id, actor.email AS actor_email,
              impersonator.id AS impersonator_id,
              impersonator.email AS impersonator_email,
              successor.previous_hash AS successor_previous_hash,
              chain_head.last_sequence AS chain_last_sequence,
              chain_head.last_hash AS chain_last_hash
       FROM audit_events ae
       INNER JOIN audit_chain_heads chain_head ON chain_head.tenant_id = ae.tenant_id
       LEFT JOIN audit_events successor ON successor.tenant_id = ae.tenant_id
         AND successor.sequence_number = ae.sequence_number + 1
       INNER JOIN users actor ON actor.id = ae.actor_user_id
         AND actor.tenant_id = ae.tenant_id
       LEFT JOIN users impersonator ON impersonator.id = ae.impersonator_user_id
         AND impersonator.tenant_id = ae.tenant_id
       WHERE ${where}
       ORDER BY ae.sequence_number DESC LIMIT ? OFFSET ?`,
      parameters,
    );
  }

  private filters(
    tenantId: string,
    query: ListAuditEventsDto,
  ): { where: string; parameters: unknown[] } {
    const clauses = ['ae.tenant_id = ?'];
    const parameters: unknown[] = [tenantId];
    if (query.q) {
      const search = `%${query.q}%`;
      clauses.push(`(
        ae.id LIKE ? OR ae.action LIKE ? OR ae.entity_type LIKE ? OR ae.entity_id LIKE ?
        OR ae.correlation_id LIKE ? OR actor.email LIKE ?
      )`);
      parameters.push(search, search, search, search, search, search);
    }
    if (query.action) {
      clauses.push('ae.action = ?');
      parameters.push(query.action);
    }
    if (query.entityType) {
      clauses.push('ae.entity_type = ?');
      parameters.push(query.entityType);
    }
    if (query.actorId) {
      clauses.push('ae.actor_user_id = ?');
      parameters.push(query.actorId);
    }
    if (query.dateFrom) {
      clauses.push('ae.created_at >= ?');
      parameters.push(query.dateFrom);
    }
    if (query.dateTo) {
      clauses.push('ae.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      parameters.push(query.dateTo);
    }
    return { where: clauses.join(' AND '), parameters };
  }

  private toEvent(row: AuditRow): AuditEventData {
    const before = this.parseJson(row.before_data);
    const after = this.parseJson(row.after_data);
    const payloadHash = this.payloadHash({
      id: row.id,
      tenantId: row.tenant_id,
      actorUserId: row.actor_id,
      impersonatorUserId: row.impersonator_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      correlationId: row.correlation_id,
      origin: row.origin,
      before,
      after,
    });
    const expectedIntegrityHash = this.sha256(
      `${row.previous_hash}:${row.sequence_number}:${payloadHash}`,
    );
    const sequence = Number(row.sequence_number);
    const chainLastSequence = Number(row.chain_last_sequence);
    const chainLinkValid =
      sequence === chainLastSequence
        ? row.integrity_hash === row.chain_last_hash
        : row.successor_previous_hash === row.integrity_hash;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      sequence,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      correlationId: row.correlation_id,
      origin: row.origin,
      createdAt: new Date(row.created_at).toISOString(),
      retentionUntil: new Date(row.retention_until).toISOString(),
      actor: { id: row.actor_id, email: row.actor_email },
      impersonator:
        row.impersonator_id && row.impersonator_email
          ? { id: row.impersonator_id, email: row.impersonator_email }
          : null,
      before,
      after,
      integrity: {
        valid:
          payloadHash === row.payload_hash &&
          expectedIntegrityHash === row.integrity_hash &&
          chainLinkValid,
        hash: row.integrity_hash,
        previousHash: row.previous_hash,
      },
    };
  }

  private validateDates(query: ListAuditEventsDto): void {
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new BadRequestException({
        code: 'INVALID_DATE_RANGE',
        message: 'La fecha inicial no puede ser posterior a la fecha final.',
      });
    }
  }

  private redactRecord(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.redact(value) as Record<string, unknown>;
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

  private payloadHash(input: Record<string, unknown>): string {
    return this.sha256(this.stableStringify(input));
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${this.stableStringify(record[key])}`,
      )
      .join(',')}}`;
  }

  private parseJson(
    value: string | Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!value) return null;
    return typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : value;
  }

  private csvCell(value: string): string {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      (error as { code?: string } | null)?.code === 'ER_DUP_ENTRY' ||
      (error instanceof QueryFailedError &&
        (error.driverError as { errno?: number }).errno === 1062)
    );
  }
}

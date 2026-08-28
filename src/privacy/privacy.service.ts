import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CustomerRepository } from '../customers/customer.repository';
import {
  CreatePrivacyLegalHoldDto,
  PrivacyActionDto,
  UpdatePrivacyPolicyDto,
} from './dto/privacy-action.dto';
import type {
  PrivacyLegalHoldData,
  PrivacyPolicyData,
  PrivacyRequestData,
} from './privacy.types';

interface PolicyRow {
  country_code: string;
  minimum_transaction_retention_days: number | string;
  transaction_retention_days: number | string;
  policy_code: string;
  version: number | string;
  updated_at: Date | string;
}

interface RequestRow {
  id: string;
  request_type: PrivacyRequestData['type'];
  status: PrivacyRequestData['status'];
  request_fingerprint: string | null;
  request_reference: string | null;
  decision_code: string;
  result_json: string | Record<string, unknown> | null;
  created_at: Date | string;
}

@Injectable()
export class PrivacyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly customers: CustomerRepository,
    private readonly audit: AuditService,
  ) {}

  classification() {
    return {
      data: {
        version: 1,
        classes: [
          {
            code: 'CUSTOMER_PII',
            fields: ['name', 'identifier', 'email', 'phone'],
            controls: ['TENANT_ISOLATION', 'PRIVACY_MANAGE', 'ANONYMIZATION'],
          },
          {
            code: 'AUTHENTICATION_SECRET',
            fields: ['passwordHash', 'sessionToken', 'resetToken'],
            controls: ['HASH_OR_DIGEST_ONLY', 'REDACTED_LOGS', 'NEVER_EXPORT'],
          },
          {
            code: 'AUDIT_METADATA',
            fields: ['actor', 'action', 'entity', 'correlationId'],
            controls: ['APPEND_ONLY', 'INTEGRITY_CHAIN', 'MINIMUM_365_DAYS'],
          },
          {
            code: 'TRANSACTION_DOCUMENT',
            fields: ['sale', 'saleLines', 'payments', 'inventoryMovements'],
            controls: ['NO_CASCADE_DELETE', 'COUNTRY_RETENTION_POLICY'],
          },
        ],
        correctionEndpoint: 'PATCH /customers/:id',
        deletionMode: 'CONTROLLED_ANONYMIZATION',
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async policy(tenantId: string) {
    return {
      data: await this.loadPolicy(this.dataSource.manager, tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async updatePolicy(input: {
    tenantId: string;
    userId: string;
    correlationId: string;
    idempotencyKey: string | undefined;
    dto: UpdatePrivacyPolicyDto;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = this.fingerprint({
      operation: 'POLICY_CHANGE',
      ...input.dto,
    });
    const result = await this.dataSource.transaction(async (manager) => {
      const replay = await this.replay(
        manager,
        input.tenantId,
        input.idempotencyKey!,
        'POLICY_CHANGE',
        fingerprint,
      );
      if (replay) return replay as unknown as PrivacyPolicyData;
      const current = await this.loadPolicy(manager, input.tenantId, true);
      if (current.version !== input.dto.expectedVersion)
        throw new ConflictException({
          code: 'PRIVACY_POLICY_VERSION_CONFLICT',
          currentVersion: current.version,
          message: 'La política cambió; recarga antes de guardar.',
        });
      if (
        input.dto.transactionRetentionDays <
        current.minimumTransactionRetentionDays
      )
        throw new BadRequestException({
          code: 'PRIVACY_RETENTION_BELOW_COUNTRY_MINIMUM',
          minimumDays: current.minimumTransactionRetentionDays,
          message: 'La retención no puede ser menor al mínimo del país.',
        });
      await manager.query(
        `UPDATE privacy_policies
         SET transaction_retention_days = ?, version = version + 1,
             changed_by_user_id = ? WHERE tenant_id = ?`,
        [input.dto.transactionRetentionDays, input.userId, input.tenantId],
      );
      const next = await this.loadPolicy(manager, input.tenantId, false);
      const requestId = await this.insertRequest(manager, {
        tenantId: input.tenantId,
        customerId: null,
        type: 'POLICY_CHANGE',
        status: 'COMPLETED',
        key: input.idempotencyKey!,
        fingerprint,
        reference: input.dto.requestReference,
        decision: 'RETENTION_POLICY_UPDATED',
        policyVersion: next.version,
        retentionUntil: null,
        result: next,
        actorUserId: input.userId,
      });
      await this.audit.recordInTransaction(manager, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'PRIVACY_POLICY_UPDATED',
        entityType: 'PRIVACY_POLICY',
        entityId: requestId,
        correlationId: input.correlationId,
        before: {
          transactionRetentionDays: current.transactionRetentionDays,
          version: current.version,
        },
        after: {
          transactionRetentionDays: next.transactionRetentionDays,
          version: next.version,
          reasonProvided: true,
        },
      });
      return next;
    });
    return { data: result, meta: { apiVersion: '1' as const } };
  }

  async report(tenantId: string, customerId: string) {
    const customer = await this.customers.findById(tenantId, customerId);
    if (!customer) throw new NotFoundException();
    const [policy, [sales], [hold], requests] = await Promise.all([
      this.loadPolicy(this.dataSource.manager, tenantId),
      this.dataSource.query<
        Array<{
          total: number | string;
          first_at: Date | string | null;
          last_at: Date | string | null;
        }>
      >(
        `SELECT COUNT(*) AS total, MIN(created_at) AS first_at,
                MAX(created_at) AS last_at
         FROM sales WHERE tenant_id = ? AND customer_id = ?`,
        [tenantId, customerId],
      ),
      this.dataSource.query<
        Array<{
          id: string;
          reason: string;
          expires_at: Date | string | null;
          created_at: Date | string;
        }>
      >(
        `SELECT id, reason, expires_at, created_at FROM privacy_legal_holds
         WHERE tenant_id = ? AND customer_id = ? AND active = TRUE
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(6))
         LIMIT 1`,
        [tenantId, customerId],
      ),
      this.dataSource.query<RequestRow[]>(
        `SELECT id, request_type, status, request_fingerprint,
                request_reference, decision_code, result_json, created_at
         FROM privacy_requests WHERE tenant_id = ? AND customer_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 20`,
        [tenantId, customerId],
      ),
    ]);
    const retentionUntil = customer.privacyRetentionUntil
      ? customer.privacyRetentionUntil
      : this.retentionUntil(sales?.last_at ?? null, policy);
    return {
      data: {
        subject: customer,
        transactions: {
          count: Number(sales?.total ?? 0),
          firstAt: this.isoNullable(sales?.first_at ?? null),
          lastAt: this.isoNullable(sales?.last_at ?? null),
          retainedUntil: retentionUntil,
          disposition: 'PRESERVED_WITHOUT_CASCADE_DELETE' as const,
        },
        policy,
        activeLegalHold: hold ? this.holdData({ ...hold, active: true }) : null,
        recentDecisions: requests.map((row) => this.requestData(row)),
        propagation: {
          primaryDatabase: 'IMMEDIATE',
          logs: 'NO_RAW_CUSTOMER_PII',
          backups: 'EXPIRES_WITH_BACKUP_LIFECYCLE_AND_REPLAY_REQUIRED',
          integrations: 'NO_CUSTOMER_PII_EXPORT_CONFIGURED',
        },
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async recordExport(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    correlationId: string;
  }) {
    await this.dataSource.transaction(async (manager) => {
      const policy = await this.loadPolicy(manager, input.tenantId);
      const requestId = await this.insertRequest(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        type: 'ACCESS_EXPORT',
        status: 'COMPLETED',
        key: null,
        fingerprint: null,
        reference: null,
        decision: 'SUBJECT_DATA_EXPORTED',
        policyVersion: policy.version,
        retentionUntil: null,
        result: null,
        actorUserId: input.userId,
      });
      await this.audit.recordInTransaction(manager, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'CUSTOMER_PRIVACY_DATA_EXPORTED',
        entityType: 'CUSTOMER',
        entityId: input.customerId,
        correlationId: input.correlationId,
        after: { privacyRequestId: requestId },
      });
    });
  }

  async createLegalHold(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    correlationId: string;
    idempotencyKey: string | undefined;
    dto: CreatePrivacyLegalHoldDto;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    if (input.dto.expiresAt && new Date(input.dto.expiresAt) <= new Date())
      throw new BadRequestException({
        code: 'PRIVACY_LEGAL_HOLD_EXPIRATION_INVALID',
        message: 'La vigencia del bloqueo debe estar en el futuro.',
      });
    const fingerprint = this.fingerprint({
      operation: 'LEGAL_HOLD',
      customerId: input.customerId,
      ...input.dto,
    });
    const data = await this.dataSource.transaction(async (manager) => {
      const replay = await this.replay(
        manager,
        input.tenantId,
        input.idempotencyKey!,
        'LEGAL_HOLD',
        fingerprint,
      );
      if (replay) return replay as unknown as PrivacyLegalHoldData;
      await this.assertCustomer(manager, input.tenantId, input.customerId);
      await this.expireHolds(manager, input.tenantId, input.customerId);
      const [existing] = await manager.query<
        Array<{
          id: string;
          active: number | boolean;
          reason: string;
          expires_at: Date | string | null;
          created_at: Date | string;
        }>
      >(
        `SELECT id, active, reason, expires_at, created_at
         FROM privacy_legal_holds
         WHERE tenant_id = ? AND customer_id = ? AND active = TRUE
         LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.customerId],
      );
      const holdId = existing?.id ?? randomUUID();
      if (!existing)
        await manager.query(
          `INSERT INTO privacy_legal_holds
            (id, tenant_id, customer_id, reason, expires_at, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            holdId,
            input.tenantId,
            input.customerId,
            input.dto.reason,
            input.dto.expiresAt ? new Date(input.dto.expiresAt) : null,
            input.userId,
          ],
        );
      const [hold] = await manager.query<
        Array<{
          id: string;
          active: number | boolean;
          reason: string;
          expires_at: Date | string | null;
          created_at: Date | string;
        }>
      >(
        `SELECT id, active, reason, expires_at, created_at
         FROM privacy_legal_holds WHERE id = ? AND tenant_id = ?`,
        [holdId, input.tenantId],
      );
      const result = this.holdData(hold);
      const policy = await this.loadPolicy(manager, input.tenantId);
      const requestId = await this.insertRequest(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        type: 'LEGAL_HOLD',
        status: 'COMPLETED',
        key: input.idempotencyKey!,
        fingerprint,
        reference: input.dto.requestReference,
        decision: existing ? 'LEGAL_HOLD_ALREADY_ACTIVE' : 'LEGAL_HOLD_CREATED',
        policyVersion: policy.version,
        retentionUntil: null,
        result,
        actorUserId: input.userId,
      });
      await this.audit.recordInTransaction(manager, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'CUSTOMER_PRIVACY_LEGAL_HOLD_APPLIED',
        entityType: 'CUSTOMER',
        entityId: input.customerId,
        correlationId: input.correlationId,
        after: {
          privacyRequestId: requestId,
          legalHoldId: result.id,
          expiresAt: result.expiresAt,
          reasonProvided: true,
        },
      });
      return result;
    });
    return { data, meta: { apiVersion: '1' as const } };
  }

  async releaseLegalHold(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    correlationId: string;
    idempotencyKey: string | undefined;
    dto: PrivacyActionDto;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = this.fingerprint({
      operation: 'LEGAL_HOLD_RELEASE',
      customerId: input.customerId,
      ...input.dto,
    });
    const result = await this.dataSource.transaction(async (manager) => {
      const replay = await this.replay(
        manager,
        input.tenantId,
        input.idempotencyKey!,
        'LEGAL_HOLD_RELEASE',
        fingerprint,
      );
      if (replay) return replay as unknown as { released: boolean };
      await this.assertCustomer(manager, input.tenantId, input.customerId);
      await this.expireHolds(manager, input.tenantId, input.customerId);
      const update = await manager.query<{ affectedRows?: number }>(
        `UPDATE privacy_legal_holds
         SET active = FALSE, released_by_user_id = ?,
             released_at = CURRENT_TIMESTAMP(6), release_reason = ?
         WHERE tenant_id = ? AND customer_id = ? AND active = TRUE`,
        [input.userId, input.dto.reason, input.tenantId, input.customerId],
      );
      const data = { released: Number(update.affectedRows ?? 0) > 0 };
      const policy = await this.loadPolicy(manager, input.tenantId);
      const requestId = await this.insertRequest(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        type: 'LEGAL_HOLD_RELEASE',
        status: 'COMPLETED',
        key: input.idempotencyKey!,
        fingerprint,
        reference: input.dto.requestReference,
        decision: data.released
          ? 'LEGAL_HOLD_RELEASED'
          : 'NO_ACTIVE_LEGAL_HOLD',
        policyVersion: policy.version,
        retentionUntil: null,
        result: data,
        actorUserId: input.userId,
      });
      await this.audit.recordInTransaction(manager, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'CUSTOMER_PRIVACY_LEGAL_HOLD_RELEASED',
        entityType: 'CUSTOMER',
        entityId: input.customerId,
        correlationId: input.correlationId,
        after: {
          privacyRequestId: requestId,
          released: data.released,
          reasonProvided: true,
        },
      });
      return data;
    });
    return { data: result, meta: { apiVersion: '1' as const } };
  }

  async anonymize(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    correlationId: string;
    idempotencyKey: string | undefined;
    dto: PrivacyActionDto;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = this.fingerprint({
      operation: 'ANONYMIZATION',
      customerId: input.customerId,
      ...input.dto,
    });
    const outcome = await this.dataSource.transaction(async (manager) => {
      const replayRow = await this.requestByKey(
        manager,
        input.tenantId,
        input.idempotencyKey!,
      );
      if (replayRow) {
        this.assertReplay(replayRow, 'ANONYMIZATION', fingerprint);
        return {
          blocked: replayRow.status === 'BLOCKED',
          data: this.parseResult(replayRow.result_json),
        };
      }
      const customer = await this.assertCustomer(
        manager,
        input.tenantId,
        input.customerId,
        true,
      );
      await this.expireHolds(manager, input.tenantId, input.customerId);
      const [hold] = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM privacy_legal_holds
         WHERE tenant_id = ? AND customer_id = ? AND active = TRUE
         LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.customerId],
      );
      const policy = await this.loadPolicy(manager, input.tenantId);
      const [sale] = await manager.query<
        Array<{ last_at: Date | string | null }>
      >(
        `SELECT MAX(created_at) AS last_at FROM sales
         WHERE tenant_id = ? AND customer_id = ?`,
        [input.tenantId, input.customerId],
      );
      const retentionUntil = this.retentionUntil(sale?.last_at ?? null, policy);
      if (hold) {
        const data = {
          anonymized: false,
          privacyStatus: customer.privacy_status,
          legalHoldId: hold.id,
        };
        const requestId = await this.insertRequest(manager, {
          tenantId: input.tenantId,
          customerId: input.customerId,
          type: 'ANONYMIZATION',
          status: 'BLOCKED',
          key: input.idempotencyKey!,
          fingerprint,
          reference: input.dto.requestReference,
          decision: 'ACTIVE_LEGAL_HOLD',
          policyVersion: policy.version,
          retentionUntil,
          result: data,
          actorUserId: input.userId,
        });
        await this.audit.recordInTransaction(manager, {
          tenantId: input.tenantId,
          actorUserId: input.userId,
          action: 'CUSTOMER_ANONYMIZATION_BLOCKED',
          entityType: 'CUSTOMER',
          entityId: input.customerId,
          correlationId: input.correlationId,
          after: {
            privacyRequestId: requestId,
            decision: 'ACTIVE_LEGAL_HOLD',
          },
        });
        return { blocked: true, data };
      }
      const alreadyAnonymized = customer.privacy_status === 'ANONYMIZED';
      if (!alreadyAnonymized)
        await manager.query(
          `UPDATE customers
           SET name = ?, normalized_name = ?, identifier = NULL,
               normalized_identifier = NULL, email = NULL,
               normalized_email = NULL, phone = NULL, normalized_phone = NULL,
               data_processing_consent = FALSE, active = FALSE,
               privacy_status = 'ANONYMIZED',
               anonymized_at = CURRENT_TIMESTAMP(6),
               privacy_retention_until = ?, version = version + 1
           WHERE id = ? AND tenant_id = ?`,
          [
            `Cliente anonimizado ${input.customerId.slice(0, 8)}`,
            `cliente anonimizado ${input.customerId.slice(0, 8)}`,
            retentionUntil ? new Date(retentionUntil) : null,
            input.customerId,
            input.tenantId,
          ],
        );
      const data = {
        anonymized: true,
        privacyStatus: 'ANONYMIZED' as const,
        retainedUntil: retentionUntil,
      };
      const requestId = await this.insertRequest(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        type: 'ANONYMIZATION',
        status: 'COMPLETED',
        key: input.idempotencyKey!,
        fingerprint,
        reference: input.dto.requestReference,
        decision: alreadyAnonymized
          ? 'ALREADY_ANONYMIZED'
          : 'CUSTOMER_PII_ANONYMIZED',
        policyVersion: policy.version,
        retentionUntil,
        result: data,
        actorUserId: input.userId,
      });
      await this.audit.recordInTransaction(manager, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'CUSTOMER_PII_ANONYMIZED',
        entityType: 'CUSTOMER',
        entityId: input.customerId,
        correlationId: input.correlationId,
        before: {
          privacyStatus: customer.privacy_status,
          hadIdentifier: customer.identifier !== null,
          hadEmail: customer.email !== null,
          hadPhone: customer.phone !== null,
        },
        after: {
          privacyRequestId: requestId,
          privacyStatus: 'ANONYMIZED',
          transactionRecordsPreserved: true,
          retainedUntil: retentionUntil,
        },
      });
      return { blocked: false, data };
    });
    if (outcome.blocked)
      throw new ConflictException({
        code: 'CUSTOMER_ANONYMIZATION_BLOCKED_BY_LEGAL_HOLD',
        legalHoldId: (outcome.data as { legalHoldId?: string }).legalHoldId,
        message: 'Existe un bloqueo legal activo para este cliente.',
      });
    return { data: outcome.data, meta: { apiVersion: '1' as const } };
  }

  private async loadPolicy(
    manager: EntityManager,
    tenantId: string,
    lock = false,
  ): Promise<PrivacyPolicyData> {
    const [row] = await manager.query<PolicyRow[]>(
      `SELECT country_code, minimum_transaction_retention_days,
              transaction_retention_days, policy_code, version, updated_at
       FROM privacy_policies WHERE tenant_id = ?${lock ? ' FOR UPDATE' : ''}`,
      [tenantId],
    );
    if (!row) throw new NotFoundException();
    return {
      countryCode: row.country_code,
      minimumTransactionRetentionDays: Number(
        row.minimum_transaction_retention_days,
      ),
      transactionRetentionDays: Number(row.transaction_retention_days),
      policyCode: row.policy_code,
      version: Number(row.version),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private async assertCustomer(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
    lock = false,
  ) {
    const [row] = await manager.query<
      Array<{
        id: string;
        identifier: string | null;
        email: string | null;
        phone: string | null;
        privacy_status: 'ACTIVE' | 'ANONYMIZED';
      }>
    >(
      `SELECT id, identifier, email, phone, privacy_status FROM customers
       WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`,
      [tenantId, customerId],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  private async expireHolds(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE privacy_legal_holds SET active = FALSE,
              released_at = COALESCE(released_at, CURRENT_TIMESTAMP(6)),
              release_reason = COALESCE(release_reason, 'EXPIRED')
       WHERE tenant_id = ? AND customer_id = ? AND active = TRUE
         AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP(6)`,
      [tenantId, customerId],
    );
  }

  private async replay(
    manager: EntityManager,
    tenantId: string,
    key: string,
    type: PrivacyRequestData['type'],
    fingerprint: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.requestByKey(manager, tenantId, key);
    if (!row) return null;
    this.assertReplay(row, type, fingerprint);
    return this.parseResult(row.result_json);
  }

  private async requestByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ): Promise<RequestRow | null> {
    const [row] = await manager.query<RequestRow[]>(
      `SELECT id, request_type, status, request_fingerprint,
              request_reference, decision_code, result_json, created_at
       FROM privacy_requests WHERE tenant_id = ? AND idempotency_key = ?`,
      [tenantId, key],
    );
    return row ?? null;
  }

  private assertReplay(
    row: RequestRow,
    type: PrivacyRequestData['type'],
    fingerprint: string,
  ): void {
    if (row.request_type !== type || row.request_fingerprint !== fingerprint)
      throw new ConflictException({
        code: 'PRIVACY_IDEMPOTENCY_CONFLICT',
        message: 'La clave idempotente ya se usó para otra solicitud.',
      });
  }

  private async insertRequest(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string | null;
      type: PrivacyRequestData['type'];
      status: PrivacyRequestData['status'];
      key: string | null;
      fingerprint: string | null;
      reference: string | undefined | null;
      decision: string;
      policyVersion: number;
      retentionUntil: string | null;
      result: unknown;
      actorUserId: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await manager.query(
      `INSERT INTO privacy_requests
        (id, tenant_id, customer_id, request_type, status, idempotency_key,
         request_fingerprint, request_reference, decision_code, policy_version,
         retention_until, result_json, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.tenantId,
        input.customerId,
        input.type,
        input.status,
        input.key,
        input.fingerprint,
        input.reference ?? null,
        input.decision,
        input.policyVersion,
        input.retentionUntil ? new Date(input.retentionUntil) : null,
        input.result === null ? null : JSON.stringify(input.result),
        input.actorUserId,
      ],
    );
    return id;
  }

  private requestData(row: RequestRow): PrivacyRequestData {
    return {
      id: row.id,
      type: row.request_type,
      status: row.status,
      decisionCode: row.decision_code,
      requestReference: row.request_reference,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private holdData(row: {
    id: string;
    active: number | boolean;
    reason: string;
    expires_at: Date | string | null;
    created_at: Date | string;
  }): PrivacyLegalHoldData {
    return {
      id: row.id,
      active: Boolean(row.active),
      reason: row.reason,
      expiresAt: this.isoNullable(row.expires_at),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private retentionUntil(
    date: Date | string | null,
    policy: PrivacyPolicyData,
  ): string | null {
    if (!date) return null;
    const retained = new Date(date);
    retained.setUTCDate(
      retained.getUTCDate() + policy.transactionRetentionDays,
    );
    return retained.toISOString();
  }

  private isoNullable(value: Date | string | null): string | null {
    return value ? new Date(value).toISOString() : null;
  }

  private parseResult(
    value: string | Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (!value) return {};
    return typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : value;
  }

  private fingerprint(value: Record<string, unknown>): string {
    const canonical = Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private assertIdempotencyKey(key: string | undefined): asserts key is string {
    if (!key || key.length < 8 || key.length > 128)
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
  }
}

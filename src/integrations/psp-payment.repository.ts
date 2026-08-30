import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  PspIdempotencyConflictError,
  PspPaymentNotFoundError,
} from './psp-payment.errors';
import type {
  PspAction,
  PspPaymentData,
  PspPaymentStatus,
  PspScenario,
  PspWebhookResult,
} from './psp-payment.types';

interface PspPaymentRow {
  id: string;
  tenant_id: string;
  provider: 'SIMULATOR';
  adapter_version: '1';
  provider_reference: string;
  merchant_reference: string;
  amount: string;
  refunded_amount: string;
  currency: string;
  status: PspPaymentStatus;
  scenario: PspScenario;
  error_code: string | null;
  create_idempotency_key: string;
  request_fingerprint: string;
  webhook_token_hash: string;
  correlation_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PspActionRow {
  payment_id: string;
  action: PspAction;
  request_fingerprint: string;
  result: string | PspPaymentData;
}

@Injectable()
export class PspPaymentRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: {
    tenantId: string;
    userId: string;
    providerReference: string;
    merchantReference: string;
    amount: string;
    currency: string;
    scenario: PspScenario;
    idempotencyKey: string;
    fingerprint: string;
    webhookTokenHash: string;
    correlationId: string;
  }): Promise<{ payment: PspPaymentData; replay: boolean }> {
    const id = randomUUID();
    try {
      await this.dataSource.query(
        `INSERT INTO psp_payments
          (id, tenant_id, created_by_user_id, provider, adapter_version,
           provider_reference, merchant_reference, amount, currency, status,
           scenario, create_idempotency_key, request_fingerprint,
           webhook_token_hash, correlation_id)
         VALUES (?, ?, ?, 'SIMULATOR', '1', ?, ?, ?, ?,
           'REQUIRES_CONFIRMATION', ?, ?, ?, ?, ?)`,
        [
          id,
          input.tenantId,
          input.userId,
          input.providerReference,
          input.merchantReference,
          input.amount,
          input.currency,
          input.scenario,
          input.idempotencyKey,
          input.fingerprint,
          input.webhookTokenHash,
          input.correlationId,
        ],
      );
      return { payment: (await this.find(input.tenantId, id))!, replay: false };
    } catch (error) {
      if (!this.duplicate(error)) throw error;
      const existing = await this.findCreateReplay(
        input.tenantId,
        input.idempotencyKey,
        input.merchantReference,
      );
      if (!existing || existing.request_fingerprint !== input.fingerprint) {
        throw new PspIdempotencyConflictError();
      }
      return { payment: this.map(existing), replay: true };
    }
  }

  async list(tenantId: string): Promise<PspPaymentData[]> {
    const rows = await this.dataSource.query<PspPaymentRow[]>(
      `SELECT * FROM psp_payments WHERE tenant_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => this.map(row));
  }

  async find(tenantId: string, id: string): Promise<PspPaymentData | null> {
    const row = await this.row(this.dataSource.manager, tenantId, id);
    return row ? this.map(row) : null;
  }

  async webhookTarget(tenantId: string, providerReference: string) {
    const [row] = await this.dataSource.query<PspPaymentRow[]>(
      `SELECT * FROM psp_payments
       WHERE tenant_id = ? AND provider = 'SIMULATOR' AND provider_reference = ? LIMIT 1`,
      [tenantId, providerReference],
    );
    return row
      ? { payment: this.map(row), webhookTokenHash: row.webhook_token_hash }
      : null;
  }

  async action(input: {
    tenantId: string;
    paymentId: string;
    action: PspAction;
    idempotencyKey: string;
    fingerprint: string;
    correlationId: string;
    execute: (payment: PspPaymentData) =>
      | Promise<{
          status: PspPaymentStatus;
          errorCode: string | null;
          refundedAmount?: string;
        }>
      | {
          status: PspPaymentStatus;
          errorCode: string | null;
          refundedAmount?: string;
        };
  }): Promise<{ payment: PspPaymentData; replay: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [
        input.tenantId,
      ]);
      const replay = await this.actionReplay(manager, input);
      if (replay) return { payment: replay, replay: true };
      const row = await this.lock(manager, input.tenantId, input.paymentId);
      if (!row) throw new PspPaymentNotFoundError();
      const concurrent = await this.actionReplay(manager, input);
      if (concurrent) return { payment: concurrent, replay: true };
      const current = this.map(row);
      const next = await input.execute(current);
      await manager.query(
        `UPDATE psp_payments SET status = ?, error_code = ?, refunded_amount = ?
         WHERE id = ? AND tenant_id = ?`,
        [
          next.status,
          next.errorCode,
          next.refundedAmount ?? current.refundedAmount,
          input.paymentId,
          input.tenantId,
        ],
      );
      const payment = this.map(
        await this.lock(manager, input.tenantId, input.paymentId),
      );
      await manager.query(
        `INSERT INTO psp_payment_actions
          (id, tenant_id, payment_id, action, idempotency_key,
           request_fingerprint, result, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.tenantId,
          input.paymentId,
          input.action,
          input.idempotencyKey,
          input.fingerprint,
          JSON.stringify(payment),
          input.correlationId,
        ],
      );
      return { payment, replay: false };
    });
  }

  async webhook(input: {
    tenantId: string;
    eventId: string;
    providerReference: string;
    status: 'AUTHORIZED' | 'CAPTURED' | 'DECLINED';
    occurredAt: string;
    fingerprint: string;
    advance: (payment: PspPaymentData) => {
      status: PspPaymentStatus;
      ignoredOutOfOrder: boolean;
    };
  }): Promise<PspWebhookResult> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [
        input.tenantId,
      ]);
      const inserted = await manager.query<{ affectedRows?: number }>(
        `INSERT IGNORE INTO psp_webhook_events
          (id, tenant_id, payment_id, provider, event_id, event_fingerprint,
           event_status, ignored_out_of_order, occurred_at)
         SELECT ?, tenant_id, id, provider, ?, ?, ?, FALSE, ?
         FROM psp_payments
         WHERE tenant_id = ? AND provider = 'SIMULATOR' AND provider_reference = ?`,
        [
          randomUUID(),
          input.eventId,
          input.fingerprint,
          input.status,
          input.occurredAt,
          input.tenantId,
          input.providerReference,
        ],
      );
      if (Number(inserted.affectedRows ?? 0) === 0) {
        const [event] = await manager.query<
          Array<{
            payment_id: string;
            event_fingerprint: string;
            ignored_out_of_order: number | boolean;
          }>
        >(
          `SELECT payment_id, event_fingerprint, ignored_out_of_order
           FROM psp_webhook_events
           WHERE tenant_id = ? AND provider = 'SIMULATOR' AND event_id = ? LIMIT 1`,
          [input.tenantId, input.eventId],
        );
        if (!event || event.event_fingerprint !== input.fingerprint) {
          throw new PspIdempotencyConflictError();
        }
        const row = await this.row(manager, input.tenantId, event.payment_id);
        if (!row) throw new PspPaymentNotFoundError();
        return {
          payment: this.map(row),
          replay: true,
          ignoredOutOfOrder: Boolean(event.ignored_out_of_order),
        };
      }
      const [row] = await manager.query<PspPaymentRow[]>(
        `SELECT * FROM psp_payments
         WHERE tenant_id = ? AND provider = 'SIMULATOR' AND provider_reference = ?
         LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.providerReference],
      );
      if (!row) throw new PspPaymentNotFoundError();
      const next = input.advance(this.map(row));
      if (!next.ignoredOutOfOrder) {
        await manager.query(
          `UPDATE psp_payments SET status = ?, error_code = NULL
           WHERE id = ? AND tenant_id = ?`,
          [next.status, row.id, input.tenantId],
        );
      }
      await manager.query(
        `UPDATE psp_webhook_events SET ignored_out_of_order = ?
         WHERE tenant_id = ? AND provider = 'SIMULATOR' AND event_id = ?`,
        [next.ignoredOutOfOrder, input.tenantId, input.eventId],
      );
      const payment = this.map(await this.row(manager, input.tenantId, row.id));
      return {
        payment,
        replay: false,
        ignoredOutOfOrder: next.ignoredOutOfOrder,
      };
    });
  }

  private async actionReplay(
    manager: EntityManager,
    input: {
      tenantId: string;
      paymentId: string;
      action: PspAction;
      idempotencyKey: string;
      fingerprint: string;
    },
  ): Promise<PspPaymentData | null> {
    const [row] = await manager.query<PspActionRow[]>(
      `SELECT payment_id, action, request_fingerprint, result
       FROM psp_payment_actions WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.tenantId, input.idempotencyKey],
    );
    if (!row) return null;
    if (
      row.payment_id !== input.paymentId ||
      row.action !== input.action ||
      row.request_fingerprint !== input.fingerprint
    ) {
      throw new PspIdempotencyConflictError();
    }
    return this.json<PspPaymentData>(row.result);
  }

  private async findCreateReplay(
    tenantId: string,
    idempotencyKey: string,
    merchantReference: string,
  ) {
    const [row] = await this.dataSource.query<PspPaymentRow[]>(
      `SELECT * FROM psp_payments
       WHERE tenant_id = ? AND
         (create_idempotency_key = ? OR (provider = 'SIMULATOR' AND merchant_reference = ?))
       LIMIT 1`,
      [tenantId, idempotencyKey, merchantReference],
    );
    return row ?? null;
  }

  private lock(manager: EntityManager, tenantId: string, id: string) {
    return manager
      .query<PspPaymentRow[]>(
        'SELECT * FROM psp_payments WHERE tenant_id = ? AND id = ? LIMIT 1 FOR UPDATE',
        [tenantId, id],
      )
      .then(([row]) => row ?? null);
  }

  private row(manager: EntityManager, tenantId: string, id: string) {
    return manager
      .query<PspPaymentRow[]>(
        'SELECT * FROM psp_payments WHERE tenant_id = ? AND id = ? LIMIT 1',
        [tenantId, id],
      )
      .then(([row]) => row ?? null);
  }

  private map(row: PspPaymentRow): PspPaymentData {
    return {
      id: row.id,
      provider: row.provider,
      adapterVersion: row.adapter_version,
      providerReference: row.provider_reference,
      merchantReference: row.merchant_reference,
      amount: this.money(row.amount),
      refundedAmount: this.money(row.refunded_amount),
      currency: row.currency,
      status: row.status,
      scenario: row.scenario,
      errorCode: row.error_code,
      correlationId: row.correlation_id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private money(value: string): string {
    return Number(value).toFixed(2);
  }

  private json<T>(value: string | T): T {
    return typeof value === 'string' ? (JSON.parse(value) as T) : value;
  }

  private duplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}

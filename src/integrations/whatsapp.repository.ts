import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { ExternalAdapterExecutionData } from './external-adapter.types';
import {
  WhatsappConsentRequiredError,
  WhatsappIdempotencyConflictError,
  WhatsappMessageNotFoundError,
  WhatsappPhoneRequiredError,
  WhatsappRateLimitError,
  WhatsappWebhookConflictError,
} from './whatsapp.errors';
import type {
  WhatsappConsentData,
  WhatsappMessageData,
  WhatsappMessageStatus,
  WhatsappTemplateKey,
} from './whatsapp.types';

interface MessageRow {
  id: string;
  customer_id: string;
  customer_name: string;
  template_key: WhatsappTemplateKey;
  template_version: '1';
  reference_key: string | null;
  recipient_last4: string;
  status: WhatsappMessageStatus;
  provider_reference: string | null;
  webhook_token_hash: string;
  error_code: string | null;
  last_event_at: Date | string | null;
  request_fingerprint: string;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class WhatsappRepository {
  constructor(private readonly dataSource: DataSource) {}

  async consents(tenantId: string): Promise<WhatsappConsentData[]> {
    const rows = await this.dataSource.query<
      Array<{
        customer_id: string;
        customer_name: string;
        phone: string | null;
        status: 'OPTED_IN' | 'OPTED_OUT';
        changed_at: Date | string;
      }>
    >(
      `SELECT customer.id customer_id, customer.name customer_name, customer.phone,
              COALESCE(consent.status, 'OPTED_OUT') status,
              COALESCE(consent.changed_at, customer.created_at) changed_at
       FROM customers customer
       LEFT JOIN customer_whatsapp_consents consent
         ON consent.tenant_id = customer.tenant_id AND consent.customer_id = customer.id
       WHERE customer.tenant_id = ? AND customer.active = TRUE
       ORDER BY customer.name, customer.id LIMIT 200`,
      [tenantId],
    );
    return rows.map((row) => ({
      customerId: row.customer_id,
      customerName: row.customer_name,
      phoneMasked: row.phone ? this.mask(row.phone) : null,
      status: row.status,
      changedAt: new Date(row.changed_at).toISOString(),
    }));
  }

  async setConsent(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    enabled: boolean;
  }): Promise<WhatsappConsentData> {
    const [customer] = await this.dataSource.query<
      Array<{ id: string; phone: string | null }>
    >(
      'SELECT id, phone FROM customers WHERE tenant_id = ? AND id = ? AND active = TRUE LIMIT 1',
      [input.tenantId, input.customerId],
    );
    if (!customer) throw new WhatsappMessageNotFoundError();
    if (input.enabled && !customer.phone)
      throw new WhatsappPhoneRequiredError();
    await this.dataSource.query(
      `INSERT INTO customer_whatsapp_consents
       (tenant_id, customer_id, status, changed_by_user_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status),
         changed_by_user_id = VALUES(changed_by_user_id), changed_at = CURRENT_TIMESTAMP(6)`,
      [
        input.tenantId,
        input.customerId,
        input.enabled ? 'OPTED_IN' : 'OPTED_OUT',
        input.userId,
      ],
    );
    return (await this.consents(input.tenantId)).find(
      ({ customerId }) => customerId === input.customerId,
    )!;
  }

  async begin(input: {
    tenantId: string;
    customerId: string;
    templateKey: WhatsappTemplateKey;
    reference: string | null;
    idempotencyKey: string;
    fingerprint: string;
    webhookTokenHash: string;
  }): Promise<{
    message: WhatsappMessageData;
    phone: string | null;
    replay: boolean;
  }> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [
        input.tenantId,
      ]);
      const existing = await this.byKey(
        manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.request_fingerprint !== input.fingerprint)
          throw new WhatsappIdempotencyConflictError();
        return { message: this.map(existing), phone: null, replay: true };
      }
      const [target] = await manager.query<
        Array<{
          name: string;
          phone: string | null;
          consent_status: string | null;
        }>
      >(
        `SELECT customer.name, customer.phone, consent.status consent_status
         FROM customers customer
         LEFT JOIN customer_whatsapp_consents consent
           ON consent.tenant_id = customer.tenant_id AND consent.customer_id = customer.id
         WHERE customer.tenant_id = ? AND customer.id = ? AND customer.active = TRUE
         LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.customerId],
      );
      if (!target) throw new WhatsappMessageNotFoundError();
      if (!target.phone) throw new WhatsappPhoneRequiredError();
      if (target.consent_status !== 'OPTED_IN')
        throw new WhatsappConsentRequiredError();
      const [rate] = await manager.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) total FROM whatsapp_messages
         WHERE tenant_id = ? AND customer_id = ?
           AND created_at >= DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 HOUR)`,
        [input.tenantId, input.customerId],
      );
      if (Number(rate.total) >= 20) throw new WhatsappRateLimitError();
      const id = randomUUID();
      const digits = target.phone.replace(/\D/g, '');
      await manager.query(
        `INSERT INTO whatsapp_messages
         (id, tenant_id, customer_id, template_key, template_version,
          reference_key, recipient_hash, recipient_last4, status,
          idempotency_key, request_fingerprint, webhook_token_hash)
         VALUES (?, ?, ?, ?, '1', ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [
          id,
          input.tenantId,
          input.customerId,
          input.templateKey,
          input.reference,
          this.hash(digits),
          digits.slice(-4).padStart(4, '*'),
          input.idempotencyKey,
          input.fingerprint,
          input.webhookTokenHash,
        ],
      );
      return {
        message: this.map(await this.byId(manager, input.tenantId, id)),
        phone: target.phone,
        replay: false,
      };
    });
  }

  async finish(
    tenantId: string,
    messageId: string,
    execution: ExternalAdapterExecutionData,
  ): Promise<WhatsappMessageData> {
    const status: WhatsappMessageStatus =
      execution.status === 'SUCCEEDED'
        ? 'SENT'
        : execution.status === 'REJECTED'
          ? 'REJECTED'
          : execution.status === 'TIMED_OUT'
            ? 'TIMED_OUT'
            : 'FAILED';
    await this.dataSource.query(
      `UPDATE whatsapp_messages SET status = ?, external_execution_id = ?,
         provider_reference = ?, error_code = ?,
         last_event_at = CASE WHEN ? = 'SENT' THEN CURRENT_TIMESTAMP(6) ELSE last_event_at END
       WHERE tenant_id = ? AND id = ?`,
      [
        status,
        execution.id,
        execution.providerReference,
        execution.errorCode,
        status,
        tenantId,
        messageId,
      ],
    );
    return this.map(
      await this.byId(this.dataSource.manager, tenantId, messageId),
    );
  }

  async webhookTarget(tenantId: string, providerReference: string) {
    const [row] = await this.dataSource.query<MessageRow[]>(
      `${this.select()} WHERE message.tenant_id = ? AND message.provider_reference = ? LIMIT 1`,
      [tenantId, providerReference],
    );
    return row
      ? { message: this.map(row), webhookTokenHash: row.webhook_token_hash }
      : null;
  }

  async webhook(input: {
    tenantId: string;
    messageId: string;
    providerEventId: string;
    status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
    occurredAt: Date;
  }) {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [
        input.tenantId,
      ]);
      const [existing] = await manager.query<
        Array<{
          message_id: string;
          status: string;
          occurred_at: Date | string;
          ignored_out_of_order: number | boolean;
        }>
      >(
        `SELECT message_id, status, occurred_at, ignored_out_of_order
         FROM whatsapp_webhook_events
         WHERE tenant_id = ? AND provider_event_id = ? LIMIT 1`,
        [input.tenantId, input.providerEventId],
      );
      if (existing) {
        if (
          existing.message_id !== input.messageId ||
          existing.status !== input.status ||
          new Date(existing.occurred_at).getTime() !==
            input.occurredAt.getTime()
        )
          throw new WhatsappWebhookConflictError();
        return {
          replay: true,
          ignoredOutOfOrder: Boolean(existing.ignored_out_of_order),
        };
      }
      const row = await this.byId(
        manager,
        input.tenantId,
        input.messageId,
        true,
      );
      if (!row) throw new WhatsappMessageNotFoundError();
      const ignored =
        this.rank(input.status) < this.rank(row.status) ||
        (row.last_event_at !== null &&
          input.occurredAt < new Date(row.last_event_at));
      await manager.query(
        `INSERT INTO whatsapp_webhook_events
         (id, tenant_id, message_id, provider_event_id, status, occurred_at, ignored_out_of_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.tenantId,
          input.messageId,
          input.providerEventId,
          input.status,
          input.occurredAt,
          ignored,
        ],
      );
      if (!ignored) {
        await manager.query(
          `UPDATE whatsapp_messages SET status = ?, error_code = ?, last_event_at = ?
           WHERE tenant_id = ? AND id = ?`,
          [
            input.status,
            input.status === 'FAILED' ? 'PROVIDER_DELIVERY_FAILED' : null,
            input.occurredAt,
            input.tenantId,
            input.messageId,
          ],
        );
      }
      return { replay: false, ignoredOutOfOrder: ignored };
    });
  }

  async messages(tenantId: string): Promise<WhatsappMessageData[]> {
    const rows = await this.dataSource.query<MessageRow[]>(
      `${this.select()} WHERE message.tenant_id = ? ORDER BY message.created_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => this.map(row));
  }

  private byKey(manager: EntityManager, tenantId: string, key: string) {
    return manager
      .query<MessageRow[]>(
        `${this.select()} WHERE message.tenant_id = ? AND message.idempotency_key = ? LIMIT 1`,
        [tenantId, key],
      )
      .then(([row]) => row);
  }

  private byId(
    manager: EntityManager,
    tenantId: string,
    id: string,
    lock = false,
  ) {
    return manager
      .query<MessageRow[]>(
        `${this.select()} WHERE message.tenant_id = ? AND message.id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
        [tenantId, id],
      )
      .then(([row]) => row);
  }

  private select() {
    return `SELECT message.*, customer.name customer_name
      FROM whatsapp_messages message
      INNER JOIN customers customer
        ON customer.id = message.customer_id AND customer.tenant_id = message.tenant_id`;
  }

  private map(row: MessageRow): WhatsappMessageData {
    return {
      id: row.id,
      customer: { id: row.customer_id, name: row.customer_name },
      template: { key: row.template_key, version: row.template_version },
      reference: row.reference_key,
      recipientMasked: `***${row.recipient_last4}`,
      provider: 'SIMULATOR',
      providerReference: row.provider_reference,
      status: row.status,
      errorCode: row.error_code,
      lastEventAt: row.last_event_at
        ? new Date(row.last_event_at).toISOString()
        : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private mask(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return `***${digits.slice(-4)}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private rank(status: WhatsappMessageStatus): number {
    return {
      PENDING: 0,
      SENT: 1,
      DELIVERED: 2,
      READ: 3,
      REJECTED: 4,
      FAILED: 4,
      TIMED_OUT: 0,
    }[status];
  }
}

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2';
import { DataSource } from 'typeorm';
import type {
  CommerceCredentialData,
  CommercePrincipal,
  CommerceScope,
  CommerceWebhookDeliveryData,
  CommerceWebhookEvent,
} from './commerce.types';

interface CredentialRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string | CommerceScope[];
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  location_id: string;
  location_name: string;
  location_code: string;
  customer_id: string;
  customer_name: string;
  active: number | boolean;
  rate_limit_per_minute: number;
  webhook_url: string | null;
  webhook_events: string | CommerceWebhookEvent[];
  webhook_enabled: number | boolean;
  created_by_user_id: string;
  last_used_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: CommerceWebhookEvent;
  target_url: string;
  signature: string;
  status: CommerceWebhookDeliveryData['status'];
  attempt_count: number;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  delivered_at: Date | string | null;
}

export interface CommerceCatalogRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  base_unit: string;
  quantity_precision: number | string;
  minimum_quantity: string;
  price: string;
  active: number | boolean;
  stock_behavior: string;
  quantity: string;
  available_quantity: string;
  changed_at: Date | string;
  changed_cursor: string;
  currency: string;
}

@Injectable()
export class CommerceRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createCredential(input: {
    tenantId: string;
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: CommerceScope[];
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    locationId: string;
    customerId: string;
    rateLimitPerMinute: number;
    webhookUrl: string | null;
    webhookEvents: CommerceWebhookEvent[];
    webhookEnabled: boolean;
  }): Promise<CommerceCredentialData | null> {
    const id = randomUUID();
    await this.dataSource.query(
      `INSERT INTO commerce_api_credentials
       (id, tenant_id, name, key_prefix, key_hash, scopes, branch_id,
        warehouse_id, cash_register_id, location_id, customer_id,
        rate_limit_per_minute, webhook_url, webhook_events, webhook_enabled,
        created_by_user_id)
       SELECT ?, ?, ?, ?, ?, ?, b.id, w.id, cr.id, l.id, c.id, ?, ?, ?, ?, ?
       FROM branches b
       JOIN warehouses w ON w.id = ? AND w.tenant_id = b.tenant_id AND w.branch_id = b.id
       JOIN locations l ON l.id = ? AND l.tenant_id = b.tenant_id AND l.warehouse_id = w.id
       JOIN cash_registers cr ON cr.id = ? AND cr.tenant_id = b.tenant_id AND cr.branch_id = b.id
       JOIN customers c ON c.id = ? AND c.tenant_id = b.tenant_id
       WHERE b.id = ? AND b.tenant_id = ?`,
      [
        id,
        input.tenantId,
        input.name,
        input.keyPrefix,
        input.keyHash,
        JSON.stringify(input.scopes),
        input.rateLimitPerMinute,
        input.webhookUrl,
        JSON.stringify(input.webhookEvents),
        input.webhookEnabled,
        input.userId,
        input.warehouseId,
        input.locationId,
        input.cashRegisterId,
        input.customerId,
        input.branchId,
        input.tenantId,
      ],
    );
    return this.findCredential(input.tenantId, id);
  }

  async listCredentials(tenantId: string): Promise<CommerceCredentialData[]> {
    const rows = await this.credentialRows(
      `WHERE credential.tenant_id = ? ORDER BY credential.created_at DESC`,
      [tenantId],
    );
    return rows.map((row) => this.mapCredential(row));
  }

  async findCredential(
    tenantId: string,
    credentialId: string,
  ): Promise<CommerceCredentialData | null> {
    const rows = await this.credentialRows(
      `WHERE credential.tenant_id = ? AND credential.id = ? LIMIT 1`,
      [tenantId, credentialId],
    );
    return rows[0] ? this.mapCredential(rows[0]) : null;
  }

  async revokeCredential(tenantId: string, credentialId: string) {
    const result = await this.dataSource.query<ResultSetHeader>(
      `UPDATE commerce_api_credentials SET active = FALSE
       WHERE tenant_id = ? AND id = ? AND active = TRUE`,
      [tenantId, credentialId],
    );
    return result.affectedRows > 0;
  }

  async authenticate(keyPrefix: string, keyHash: string) {
    const rows = await this.credentialRows(
      `WHERE credential.key_prefix = ? AND credential.key_hash = ?
       AND credential.active = TRUE LIMIT 1`,
      [keyPrefix, keyHash],
    );
    const row = rows[0];
    if (!row) return null;
    await this.dataSource.query(
      'UPDATE commerce_api_credentials SET last_used_at = CURRENT_TIMESTAMP(6) WHERE id = ?',
      [row.id],
    );
    return this.mapPrincipal(row);
  }

  async consumeRateLimit(principal: CommercePrincipal): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO commerce_api_usage_windows
         (credential_id, tenant_id, window_started_at, request_count)
         VALUES (?, ?, DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:00'), 1)
         ON DUPLICATE KEY UPDATE request_count = request_count + 1`,
        [principal.credentialId, principal.tenantId],
      );
      const rows = await manager.query<Array<{ request_count: number }>>(
        `SELECT request_count FROM commerce_api_usage_windows
         WHERE credential_id = ?
         AND window_started_at = DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:00')`,
        [principal.credentialId],
      );
      return Number(rows[0]?.request_count ?? 1);
    });
  }

  async catalog(input: {
    principal: CommercePrincipal;
    cursor: { updatedAt: string; id: string } | null;
    limit: number;
  }) {
    const cursorSql = input.cursor
      ? 'AND (GREATEST(p.updated_at, COALESCE(ib.updated_at, p.updated_at)) > ? OR (GREATEST(p.updated_at, COALESCE(ib.updated_at, p.updated_at)) = ? AND p.id > ?))'
      : '';
    const cursorParams = input.cursor
      ? [input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id]
      : [];
    return this.dataSource.query<CommerceCatalogRow[]>(
      `SELECT p.id, p.name, p.sku, p.barcode, p.base_unit, p.quantity_precision,
              p.minimum_quantity, p.price, p.active, p.stock_behavior,
              COALESCE(ib.quantity, 0) AS quantity,
              COALESCE(ib.available_quantity, 0) AS available_quantity,
              GREATEST(p.updated_at, COALESCE(ib.updated_at, p.updated_at)) AS changed_at,
              DATE_FORMAT(
                GREATEST(p.updated_at, COALESCE(ib.updated_at, p.updated_at)),
                '%Y-%m-%d %H:%i:%s.%f'
              ) AS changed_cursor,
              CASE t.country_code WHEN 'MX' THEN 'MXN' WHEN 'CL' THEN 'CLP' ELSE 'USD' END AS currency
       FROM products p
       JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN inventory_balances ib ON ib.tenant_id = p.tenant_id
         AND ib.product_id = p.id AND ib.location_id = ?
       WHERE p.tenant_id = ? ${cursorSql}
       ORDER BY changed_at, p.id LIMIT ?`,
      [
        input.principal.context.locationId,
        input.principal.tenantId,
        ...cursorParams,
        input.limit + 1,
      ],
    );
  }

  async findExternalOrder(
    principal: CommercePrincipal,
    externalOrderId: string,
  ): Promise<{ order_id: string; request_fingerprint: string } | null> {
    const rows = await this.dataSource.query<
      Array<{ order_id: string; request_fingerprint: string }>
    >(
      `SELECT order_id, request_fingerprint FROM commerce_external_orders
       WHERE tenant_id = ? AND credential_id = ? AND external_order_id = ? LIMIT 1`,
      [principal.tenantId, principal.credentialId, externalOrderId],
    );
    return rows[0] ?? null;
  }

  async linkExternalOrder(input: {
    principal: CommercePrincipal;
    externalOrderId: string;
    orderId: string;
    fingerprint: string;
  }) {
    await this.dataSource.query(
      `INSERT IGNORE INTO commerce_external_orders
       (id, tenant_id, credential_id, external_order_id, order_id, request_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.principal.tenantId,
        input.principal.credentialId,
        input.externalOrderId,
        input.orderId,
        input.fingerprint,
      ],
    );
  }

  async webhookConfiguration(tenantId: string, orderId: string) {
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        key_hash: string;
        webhook_url: string;
        webhook_events: string | CommerceWebhookEvent[];
        external_order_id: string;
      }>
    >(
      `SELECT credential.id, credential.key_hash, credential.webhook_url,
              credential.webhook_events, external_order.external_order_id
       FROM commerce_external_orders external_order
       JOIN commerce_api_credentials credential
         ON credential.id = external_order.credential_id
         AND credential.tenant_id = external_order.tenant_id
       WHERE external_order.tenant_id = ? AND external_order.order_id = ?
         AND credential.active = TRUE AND credential.webhook_enabled = TRUE
       LIMIT 1`,
      [tenantId, orderId],
    );
    if (!rows[0]) return null;
    return {
      credentialId: rows[0].id,
      keyHash: rows[0].key_hash,
      url: rows[0].webhook_url,
      events: this.json<CommerceWebhookEvent[]>(rows[0].webhook_events),
      externalOrderId: rows[0].external_order_id,
    };
  }

  async createDelivery(input: {
    tenantId: string;
    credentialId: string;
    eventId: string;
    eventType: CommerceWebhookEvent;
    targetUrl: string;
    payload: object;
    signature: string;
  }) {
    await this.dataSource.query(
      `INSERT IGNORE INTO commerce_webhook_deliveries
       (id, tenant_id, credential_id, event_id, event_type, target_url, payload, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.tenantId,
        input.credentialId,
        input.eventId,
        input.eventType,
        input.targetUrl,
        JSON.stringify(input.payload),
        input.signature,
      ],
    );
    const rows = await this.dataSource.query<DeliveryRow[]>(
      `SELECT * FROM commerce_webhook_deliveries
       WHERE credential_id = ? AND event_id = ? LIMIT 1`,
      [input.credentialId, input.eventId],
    );
    return rows[0] ? this.mapDelivery(rows[0]) : null;
  }

  async updateDelivery(
    deliveryId: string,
    result: {
      status: CommerceWebhookDeliveryData['status'];
      errorCode: string | null;
    },
  ) {
    await this.dataSource.query(
      `UPDATE commerce_webhook_deliveries
       SET status = ?, attempt_count = attempt_count + 1, error_code = ?,
           delivered_at = CASE WHEN ? = 'SUCCEEDED' THEN CURRENT_TIMESTAMP(6) ELSE NULL END
       WHERE id = ? AND status <> 'SUCCEEDED' AND attempt_count < 5`,
      [result.status, result.errorCode, result.status, deliveryId],
    );
  }

  async deliveries(tenantId: string): Promise<CommerceWebhookDeliveryData[]> {
    const rows = await this.dataSource.query<DeliveryRow[]>(
      `SELECT delivery.* FROM commerce_webhook_deliveries delivery
       WHERE delivery.tenant_id = ? ORDER BY delivery.created_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => this.mapDelivery(row));
  }

  private credentialRows(where: string, params: unknown[]) {
    return this.dataSource.query<CredentialRow[]>(
      `SELECT credential.*, b.name AS branch_name, w.name AS warehouse_name,
              cr.name AS cash_register_name, cr.code AS cash_register_code,
              l.name AS location_name, l.code AS location_code,
              c.name AS customer_name
       FROM commerce_api_credentials credential
       JOIN branches b ON b.id = credential.branch_id AND b.tenant_id = credential.tenant_id
       JOIN warehouses w ON w.id = credential.warehouse_id AND w.tenant_id = credential.tenant_id
       JOIN cash_registers cr ON cr.id = credential.cash_register_id AND cr.tenant_id = credential.tenant_id
       JOIN locations l ON l.id = credential.location_id AND l.tenant_id = credential.tenant_id
       JOIN customers c ON c.id = credential.customer_id AND c.tenant_id = credential.tenant_id
       ${where}`,
      params,
    );
  }

  private mapCredential(row: CredentialRow): CommerceCredentialData {
    return {
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: this.json<CommerceScope[]>(row.scopes),
      context: {
        branch: { id: row.branch_id, name: row.branch_name },
        warehouse: { id: row.warehouse_id, name: row.warehouse_name },
        cashRegister: {
          id: row.cash_register_id,
          name: row.cash_register_name,
          code: row.cash_register_code,
        },
        location: {
          id: row.location_id,
          name: row.location_name,
          code: row.location_code,
        },
        customer: { id: row.customer_id, name: row.customer_name },
      },
      active: Boolean(row.active),
      rateLimitPerMinute: Number(row.rate_limit_per_minute),
      webhook: {
        url: row.webhook_url,
        events: this.json<CommerceWebhookEvent[]>(row.webhook_events),
        enabled: Boolean(row.webhook_enabled),
        mode: 'SIMULATOR',
      },
      lastUsedAt: this.iso(row.last_used_at),
      createdAt: this.iso(row.created_at)!,
      updatedAt: this.iso(row.updated_at)!,
    };
  }

  private mapPrincipal(row: CredentialRow): CommercePrincipal {
    return {
      credentialId: row.id,
      tenantId: row.tenant_id,
      actorUserId: row.created_by_user_id,
      scopes: this.json<CommerceScope[]>(row.scopes),
      keyHash: row.key_hash,
      rateLimitPerMinute: Number(row.rate_limit_per_minute),
      context: {
        branchId: row.branch_id,
        warehouseId: row.warehouse_id,
        cashRegisterId: row.cash_register_id,
        locationId: row.location_id,
        customerId: row.customer_id,
      },
    };
  }

  private mapDelivery(row: DeliveryRow): CommerceWebhookDeliveryData {
    return {
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      targetUrl: row.target_url,
      signature: row.signature,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      errorCode: row.error_code,
      createdAt: this.iso(row.created_at)!,
      updatedAt: this.iso(row.updated_at)!,
      deliveredAt: this.iso(row.delivered_at),
    };
  }

  private json<T>(value: string | T): T {
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }

  private iso(value: Date | string | null): string | null {
    return value ? new Date(value).toISOString() : null;
  }
}

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { inventoryLocalDate } from '../inventory/inventory-lot-tracking';
import type { ListNotificationDeliveriesDto } from './dto/list-notification-deliveries.dto';
import type { ListNotificationsDto } from './dto/list-notifications.dto';
import type { NotificationPreferenceInputDto } from './dto/replace-notification-preferences.dto';
import type {
  NotificationData,
  NotificationDeliveryChannel,
  NotificationDeliveryData,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationFrequency,
  NotificationPreferenceData,
  NotificationSeverity,
  NotificationSourceEvent,
} from './notification.types';

interface PreferenceRow {
  id: string;
  recipient_user_id: string;
  email: string;
  event_type: NotificationEventType;
  enabled: number | boolean;
  in_app_enabled: number | boolean;
  email_enabled: number | boolean;
  push_enabled: number | boolean;
  frequency: NotificationFrequency;
  updated_at: Date | string;
}

interface NotificationRow {
  id: string;
  event_type: NotificationEventType;
  title: string;
  body: string;
  severity: NotificationSeverity;
  digest_count: number | string;
  source_occurred_at: Date | string;
  read_at: Date | string | null;
  created_at: Date | string;
}

interface DeliveryRow {
  id: string;
  notification_id: string;
  recipient_user_id: string;
  email: string;
  event_type: NotificationEventType;
  title: string;
  body: string;
  channel: NotificationDeliveryChannel;
  adapter: string;
  status: NotificationDeliveryStatus;
  attempt_count: number | string;
  next_attempt_at: Date | string;
  error_code: string | null;
  delivered_at: Date | string | null;
}

const DEFAULT_EVENTS: Array<{
  eventType: NotificationEventType;
  frequency: NotificationFrequency;
}> = [
  { eventType: 'STOCK_LOW', frequency: 'IMMEDIATE' },
  { eventType: 'LOT_EXPIRING', frequency: 'DAILY_DIGEST' },
  { eventType: 'PURCHASE_PENDING', frequency: 'DAILY_DIGEST' },
  { eventType: 'CASH_DIFFERENCE', frequency: 'IMMEDIATE' },
  { eventType: 'SYNC_FAILED', frequency: 'IMMEDIATE' },
  { eventType: 'OPERATION_FAILED', frequency: 'IMMEDIATE' },
];

@Injectable()
export class NotificationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async ensureDefaults(tenantId: string): Promise<void> {
    const admins = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT DISTINCT user.id FROM users user
       INNER JOIN user_roles user_role ON user_role.user_id = user.id
       INNER JOIN roles role ON role.id = user_role.role_id
        AND role.tenant_id = user.tenant_id
       WHERE user.tenant_id = ? AND role.code = 'ADMIN'`,
      [tenantId],
    );
    for (const admin of admins) {
      for (const event of DEFAULT_EVENTS) {
        await this.dataSource.query(
          `INSERT IGNORE INTO notification_preferences
             (id, tenant_id, recipient_user_id, event_type, enabled,
              in_app_enabled, email_enabled, push_enabled, frequency)
           VALUES (?, ?, ?, ?, TRUE, TRUE, FALSE, FALSE, ?)`,
          [randomUUID(), tenantId, admin.id, event.eventType, event.frequency],
        );
      }
    }
  }

  async listPreferences(tenantId: string): Promise<{
    preferences: NotificationPreferenceData[];
    recipients: Array<{ id: string; email: string }>;
  }> {
    await this.ensureDefaults(tenantId);
    const [rows, recipients] = await Promise.all([
      this.dataSource.query<PreferenceRow[]>(
        `SELECT preference.id, preference.recipient_user_id, user.email,
                preference.event_type, preference.enabled,
                preference.in_app_enabled, preference.email_enabled,
                preference.push_enabled, preference.frequency, preference.updated_at
         FROM notification_preferences preference
         INNER JOIN users user ON user.id = preference.recipient_user_id
          AND user.tenant_id = preference.tenant_id
         WHERE preference.tenant_id = ?
         ORDER BY user.email, FIELD(preference.event_type,
           'STOCK_LOW', 'LOT_EXPIRING', 'PURCHASE_PENDING',
           'CASH_DIFFERENCE', 'SYNC_FAILED', 'OPERATION_FAILED')`,
        [tenantId],
      ),
      this.dataSource.query<Array<{ id: string; email: string }>>(
        'SELECT id, email FROM users WHERE tenant_id = ? ORDER BY email',
        [tenantId],
      ),
    ]);
    return {
      preferences: rows.map((row) => this.toPreference(row)),
      recipients,
    };
  }

  async replacePreferences(
    tenantId: string,
    preferences: NotificationPreferenceInputDto[],
  ): Promise<NotificationPreferenceData[]> {
    await this.dataSource.transaction(async (manager) => {
      const recipientIds = Array.from(
        new Set(preferences.map(({ recipientUserId }) => recipientUserId)),
      );
      if (recipientIds.length > 0) {
        const placeholders = recipientIds.map(() => '?').join(', ');
        const [{ total }] = await manager.query<
          Array<{ total: number | string }>
        >(
          `SELECT COUNT(*) AS total FROM users
           WHERE tenant_id = ? AND id IN (${placeholders})`,
          [tenantId, ...recipientIds],
        );
        if (Number(total) !== recipientIds.length)
          throw new Error('RECIPIENT_NOT_FOUND');
      }
      await manager.query(
        'DELETE FROM notification_preferences WHERE tenant_id = ?',
        [tenantId],
      );
      for (const preference of preferences) {
        await manager.query(
          `INSERT INTO notification_preferences
             (id, tenant_id, recipient_user_id, event_type, enabled,
              in_app_enabled, email_enabled, push_enabled, frequency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            tenantId,
            preference.recipientUserId,
            preference.eventType,
            preference.enabled,
            preference.inApp,
            preference.email,
            preference.push,
            preference.frequency,
          ],
        );
      }
    });
    return (await this.listPreferences(tenantId)).preferences;
  }

  async reconcile(
    tenantId: string,
  ): Promise<{ created: number; deduplicated: number }> {
    await this.ensureDefaults(tenantId);
    const [preferences, events, branchAccess] = await Promise.all([
      this.dataSource.query<PreferenceRow[]>(
        `SELECT preference.id, preference.recipient_user_id, user.email,
                preference.event_type, preference.enabled,
                preference.in_app_enabled, preference.email_enabled,
                preference.push_enabled, preference.frequency, preference.updated_at
         FROM notification_preferences preference
         INNER JOIN users user ON user.id = preference.recipient_user_id
          AND user.tenant_id = preference.tenant_id
         WHERE preference.tenant_id = ? AND preference.enabled = TRUE`,
        [tenantId],
      ),
      this.listSourceEvents(tenantId),
      this.dataSource.query<Array<{ user_id: string; branch_id: string }>>(
        `SELECT user.id AS user_id, branch.id AS branch_id
         FROM users user
         INNER JOIN branches branch ON branch.tenant_id = user.tenant_id
          AND branch.active = TRUE
         WHERE user.tenant_id = ? AND (
           EXISTS (
             SELECT 1 FROM user_roles user_role
             INNER JOIN roles role ON role.id = user_role.role_id
              AND role.tenant_id = user_role.tenant_id
             WHERE user_role.user_id = user.id
               AND user_role.tenant_id = user.tenant_id
               AND role.code = 'ADMIN'
           ) OR EXISTS (
             SELECT 1 FROM user_branch_access branch_access
             WHERE branch_access.user_id = user.id
               AND branch_access.tenant_id = user.tenant_id
               AND branch_access.branch_id = branch.id
           )
         )`,
        [tenantId],
      ),
    ]);
    const access = new Set(
      branchAccess.map((row) => `${row.user_id}:${row.branch_id}`),
    );
    let created = 0;
    let deduplicated = 0;

    for (const row of preferences) {
      const preference = this.toPreference(row);
      const matching = events.filter(
        (event) =>
          event.eventType === preference.eventType &&
          (!event.branchId ||
            access.has(`${preference.recipient.id}:${event.branchId}`)),
      );
      const grouped =
        preference.frequency === 'DAILY_DIGEST' && matching.length > 0
          ? [this.digest(preference.eventType, matching)]
          : matching;
      for (const event of grouped) {
        const notificationId = randomUUID();
        const result = await this.dataSource.query<{ affectedRows?: number }>(
          `INSERT IGNORE INTO notifications
             (id, tenant_id, recipient_user_id, event_type, source_key,
              title, body, severity, branch_id, in_app_visible, digest_count,
              source_occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            notificationId,
            tenantId,
            preference.recipient.id,
            event.eventType,
            event.sourceKey,
            event.title,
            event.body,
            event.severity,
            event.branchId,
            preference.channels.inApp,
            preference.frequency === 'DAILY_DIGEST' ? matching.length : 1,
            new Date(event.occurredAt),
          ],
        );
        const inserted = Number(result.affectedRows ?? 0) === 1;
        if (inserted) created++;
        else {
          deduplicated++;
          await this.dataSource.query(
            `UPDATE notifications SET title = ?, body = ?, severity = ?,
               digest_count = ?, source_occurred_at = GREATEST(source_occurred_at, ?),
               in_app_visible = ?
             WHERE tenant_id = ? AND recipient_user_id = ?
               AND event_type = ? AND source_key = ?`,
            [
              event.title,
              event.body,
              event.severity,
              preference.frequency === 'DAILY_DIGEST' ? matching.length : 1,
              new Date(event.occurredAt),
              preference.channels.inApp,
              tenantId,
              preference.recipient.id,
              event.eventType,
              event.sourceKey,
            ],
          );
        }
        const [stored] = await this.dataSource.query<Array<{ id: string }>>(
          `SELECT id FROM notifications WHERE tenant_id = ? AND recipient_user_id = ?
             AND event_type = ? AND source_key = ? LIMIT 1`,
          [tenantId, preference.recipient.id, event.eventType, event.sourceKey],
        );
        if (!stored) continue;
        const channels: NotificationDeliveryChannel[] = [];
        if (preference.channels.email) channels.push('EMAIL');
        if (preference.channels.push) channels.push('PUSH');
        for (const channel of channels) {
          await this.dataSource.query(
            `INSERT IGNORE INTO notification_deliveries
               (id, tenant_id, notification_id, channel)
             VALUES (?, ?, ?, ?)`,
            [randomUUID(), tenantId, stored.id, channel],
          );
        }
      }
    }
    return { created, deduplicated };
  }

  async list(
    tenantId: string,
    userId: string,
    query: ListNotificationsDto,
  ): Promise<{ items: NotificationData[]; total: number; unread: number }> {
    const filters = [
      'notification.tenant_id = ?',
      'notification.recipient_user_id = ?',
      'notification.in_app_visible = TRUE',
    ];
    const parameters: unknown[] = [tenantId, userId];
    if (query.eventType) {
      filters.push('notification.event_type = ?');
      parameters.push(query.eventType);
    }
    if (query.unreadOnly) filters.push('notification.read_at IS NULL');
    const where = filters.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, totals, unread] = await Promise.all([
      this.dataSource.query<NotificationRow[]>(
        `SELECT notification.id, notification.event_type, notification.title,
                notification.body, notification.severity, notification.digest_count,
                notification.source_occurred_at, notification.read_at,
                notification.created_at
         FROM notifications notification WHERE ${where}
         ORDER BY notification.read_at IS NULL DESC, notification.created_at DESC
         LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM notifications notification WHERE ${where}`,
        parameters,
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM notifications
         WHERE tenant_id = ? AND recipient_user_id = ?
           AND in_app_visible = TRUE AND read_at IS NULL`,
        [tenantId, userId],
      ),
    ]);
    return {
      items: rows.map((row) => this.toNotification(row)),
      total: Number(totals[0]?.total ?? 0),
      unread: Number(unread[0]?.total ?? 0),
    };
  }

  async markRead(
    tenantId: string,
    userId: string,
    id?: string,
  ): Promise<number> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      id
        ? `UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP(6))
           WHERE id = ? AND tenant_id = ? AND recipient_user_id = ? AND in_app_visible = TRUE`
        : `UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP(6))
           WHERE tenant_id = ? AND recipient_user_id = ? AND in_app_visible = TRUE`,
      id ? [id, tenantId, userId] : [tenantId, userId],
    );
    return Number(result.affectedRows ?? 0);
  }

  async claimDueDeliveries(
    tenantId: string,
    limit = 50,
  ): Promise<DeliveryRow[]> {
    return this.dataSource.transaction(async (manager) => {
      const due = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM notification_deliveries
         WHERE tenant_id = ? AND status IN ('PENDING', 'FAILED')
           AND next_attempt_at <= CURRENT_TIMESTAMP(6) AND attempt_count < 5
         ORDER BY next_attempt_at, created_at LIMIT ? FOR UPDATE SKIP LOCKED`,
        [tenantId, limit],
      );
      if (due.length === 0) return [];
      const placeholders = due.map(() => '?').join(', ');
      const ids = due.map(({ id }) => id);
      await manager.query(
        `UPDATE notification_deliveries SET status = 'PROCESSING',
           attempt_count = attempt_count + 1, error_code = NULL
         WHERE id IN (${placeholders})`,
        ids,
      );
      return manager.query<DeliveryRow[]>(
        `SELECT delivery.id, delivery.notification_id,
                notification.recipient_user_id, user.email,
                notification.event_type, notification.title, notification.body,
                delivery.channel, delivery.adapter, delivery.status,
                delivery.attempt_count, delivery.next_attempt_at,
                delivery.error_code, delivery.delivered_at
         FROM notification_deliveries delivery
         INNER JOIN notifications notification ON notification.id = delivery.notification_id
          AND notification.tenant_id = delivery.tenant_id
         INNER JOIN users user ON user.id = notification.recipient_user_id
          AND user.tenant_id = notification.tenant_id
         WHERE delivery.id IN (${placeholders})`,
        ids,
      );
    });
  }

  async markDeliverySent(id: string, providerReference: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE notification_deliveries SET status = 'SENT', error_code = NULL,
         provider_reference = ?, delivered_at = CURRENT_TIMESTAMP(6)
       WHERE id = ? AND status = 'PROCESSING'`,
      [providerReference, id],
    );
  }

  async markDeliveryFailed(
    id: string,
    attemptCount: number,
    errorCode: string,
  ): Promise<void> {
    const delayMinutes = Math.min(60, Math.max(1, attemptCount * attemptCount));
    await this.dataSource.query(
      `UPDATE notification_deliveries SET status = 'FAILED', error_code = ?,
         next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ? MINUTE)
       WHERE id = ? AND status = 'PROCESSING'`,
      [errorCode, delayMinutes, id],
    );
  }

  async retryFailed(tenantId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE notification_deliveries SET next_attempt_at = CURRENT_TIMESTAMP(6)
       WHERE tenant_id = ? AND status = 'FAILED' AND attempt_count < 5`,
      [tenantId],
    );
  }

  async listDeliveries(
    tenantId: string,
    query: ListNotificationDeliveriesDto,
  ): Promise<NotificationDeliveryData[]> {
    const status = query.status ? 'AND delivery.status = ?' : '';
    const parameters = query.status ? [tenantId, query.status] : [tenantId];
    const rows = await this.dataSource.query<DeliveryRow[]>(
      `SELECT delivery.id, delivery.notification_id,
              notification.recipient_user_id, user.email,
              notification.event_type, notification.title, notification.body,
              delivery.channel, delivery.adapter, delivery.status,
              delivery.attempt_count, delivery.next_attempt_at,
              delivery.error_code, delivery.delivered_at
       FROM notification_deliveries delivery
       INNER JOIN notifications notification ON notification.id = delivery.notification_id
        AND notification.tenant_id = delivery.tenant_id
       INNER JOIN users user ON user.id = notification.recipient_user_id
        AND user.tenant_id = notification.tenant_id
       WHERE delivery.tenant_id = ? ${status}
       ORDER BY FIELD(delivery.status, 'FAILED', 'PENDING', 'PROCESSING', 'SENT'),
                delivery.updated_at DESC LIMIT 100`,
      parameters,
    );
    return rows.map((row) => this.toDelivery(row));
  }

  private async listSourceEvents(
    tenantId: string,
  ): Promise<NotificationSourceEvent[]> {
    const [stock, lots, purchases, cash, sync, operations] = await Promise.all([
      this.stockEvents(tenantId),
      this.lotEvents(tenantId),
      this.purchaseEvents(tenantId),
      this.cashEvents(tenantId),
      this.syncEvents(tenantId),
      this.operationEvents(tenantId),
    ]);
    return [...stock, ...lots, ...purchases, ...cash, ...sync, ...operations];
  }

  private async stockEvents(
    tenantId: string,
  ): Promise<NotificationSourceEvent[]> {
    const rows = await this.dataSource.query<
      Array<{
        product_id: string;
        product_name: string;
        sku: string;
        location_id: string;
        location_name: string;
        branch_id: string;
        status: 'LOW' | 'OUT_OF_STOCK';
        available_quantity: string;
        transitioned_at: Date | string;
      }>
    >(
      `SELECT alert.product_id, product.name AS product_name, product.sku,
              alert.location_id, location.name AS location_name, warehouse.branch_id,
              alert.status, alert.available_quantity, alert.transitioned_at
       FROM inventory_stock_alert_states alert
       INNER JOIN products product ON product.id = alert.product_id
        AND product.tenant_id = alert.tenant_id AND product.active = TRUE
       INNER JOIN locations location ON location.id = alert.location_id
        AND location.tenant_id = alert.tenant_id AND location.active = TRUE
       INNER JOIN warehouses warehouse ON warehouse.id = location.warehouse_id
        AND warehouse.tenant_id = location.tenant_id
       WHERE alert.tenant_id = ? AND alert.status IN ('LOW', 'OUT_OF_STOCK')
       ORDER BY alert.transitioned_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => ({
      eventType: 'STOCK_LOW',
      sourceKey: `stock:${row.product_id}:${row.location_id}:${row.status}:${new Date(row.transitioned_at).toISOString()}`,
      title: row.status === 'OUT_OF_STOCK' ? 'Producto agotado' : 'Stock bajo',
      body: `${row.product_name} (${row.sku}) en ${row.location_name}: ${Number(row.available_quantity).toFixed(3)} disponible.`,
      severity: row.status === 'OUT_OF_STOCK' ? 'CRITICAL' : 'WARNING',
      branchId: row.branch_id,
      occurredAt: new Date(row.transitioned_at).toISOString(),
    }));
  }

  private async lotEvents(
    tenantId: string,
  ): Promise<NotificationSourceEvent[]> {
    const rows = await this.dataSource.query<
      Array<{
        lot_id: string;
        code: string;
        expires_on: Date | string;
        product_name: string;
        sku: string;
        alert_days: number | string;
        quantity: string;
        location_id: string;
        location_name: string;
        branch_id: string;
        time_zone: string;
      }>
    >(
      `SELECT lot.id AS lot_id, lot.code, lot.expires_on,
              product.name AS product_name, product.sku,
              product.lot_expiration_alert_days AS alert_days,
              balance.quantity, location.id AS location_id,
              location.name AS location_name, branch.id AS branch_id,
              branch.timezone AS time_zone
       FROM inventory_lot_balances balance
       INNER JOIN inventory_lots lot ON lot.id = balance.lot_id
        AND lot.tenant_id = balance.tenant_id
       INNER JOIN products product ON product.id = lot.product_id
        AND product.tenant_id = lot.tenant_id AND product.active = TRUE
       INNER JOIN locations location ON location.id = balance.location_id
        AND location.tenant_id = balance.tenant_id AND location.active = TRUE
       INNER JOIN warehouses warehouse ON warehouse.id = location.warehouse_id
        AND warehouse.tenant_id = location.tenant_id
       INNER JOIN branches branch ON branch.id = warehouse.branch_id
        AND branch.tenant_id = warehouse.tenant_id AND branch.active = TRUE
       WHERE balance.tenant_id = ? AND balance.quantity > 0 AND lot.expires_on IS NOT NULL
       ORDER BY lot.expires_on, lot.id LIMIT 100`,
      [tenantId],
    );
    return rows.flatMap((row) => {
      const expiresOn = this.dateOnly(row.expires_on);
      const localDate = inventoryLocalDate(row.time_zone);
      const days = Math.round(
        (Date.parse(`${expiresOn}T00:00:00Z`) -
          Date.parse(`${localDate}T00:00:00Z`)) /
          86_400_000,
      );
      if (days > Number(row.alert_days)) return [];
      return [
        {
          eventType: 'LOT_EXPIRING' as const,
          sourceKey: `lot:${row.lot_id}:${row.location_id}:${expiresOn}`,
          title: days < 0 ? 'Lote vencido' : 'Lote próximo a vencer',
          body: `${row.product_name} (${row.sku}), lote ${row.code}, en ${row.location_name}; vence ${expiresOn}.`,
          severity: days < 0 ? 'CRITICAL' : 'WARNING',
          branchId: row.branch_id,
          occurredAt: `${localDate}T00:00:00.000Z`,
        },
      ];
    });
  }

  private async purchaseEvents(
    tenantId: string,
  ): Promise<NotificationSourceEvent[]> {
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        folio: string;
        status: string;
        updated_at: Date | string;
      }>
    >(
      `SELECT id, folio, status, updated_at FROM purchase_orders
       WHERE tenant_id = ? AND status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
       ORDER BY updated_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => ({
      eventType: 'PURCHASE_PENDING',
      sourceKey: `purchase:${row.id}:${row.status}:${new Date(row.updated_at).toISOString()}`,
      title: 'Compra pendiente de completar',
      body: `La orden ${row.folio} continúa en estado ${row.status}.`,
      severity: 'INFO',
      branchId: null,
      occurredAt: new Date(row.updated_at).toISOString(),
    }));
  }

  private async cashEvents(
    tenantId: string,
  ): Promise<NotificationSourceEvent[]> {
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        branch_id: string;
        register_code: string;
        currency: string;
        difference_at_close: string;
        closed_at: Date | string;
      }>
    >(
      `SELECT shift.id, shift.branch_id, register.code AS register_code,
              shift.currency, shift.difference_at_close, shift.closed_at
       FROM cash_register_shifts shift
       INNER JOIN cash_registers register ON register.id = shift.cash_register_id
        AND register.tenant_id = shift.tenant_id
       WHERE shift.tenant_id = ? AND shift.status = 'CLOSED'
         AND shift.difference_at_close IS NOT NULL
         AND ABS(shift.difference_at_close) > 0
       ORDER BY shift.closed_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => ({
      eventType: 'CASH_DIFFERENCE',
      sourceKey: `cash:${row.id}:${new Date(row.closed_at).toISOString()}`,
      title: 'Diferencia en cierre de caja',
      body: `La caja ${row.register_code} cerró con diferencia ${Number(row.difference_at_close).toFixed(2)} ${row.currency}.`,
      severity: 'WARNING',
      branchId: row.branch_id,
      occurredAt: new Date(row.closed_at).toISOString(),
    }));
  }

  private async syncEvents(
    tenantId: string,
  ): Promise<NotificationSourceEvent[]> {
    const rows = await this.dataSource.query<
      Array<{
        command_id: string;
        kind: string;
        completed_at: Date | string | null;
        received_at: Date | string;
      }>
    >(
      `SELECT command_id, kind, completed_at, received_at FROM offline_commands
       WHERE tenant_id = ? AND status = 'ERROR'
         AND received_at >= DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 7 DAY)
       ORDER BY received_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => ({
      eventType: 'SYNC_FAILED',
      sourceKey: `sync:${row.command_id}`,
      title: 'Operación offline requiere atención',
      body: `Una operación ${row.kind} no pudo sincronizarse. Revisa conflictos y reintentos pendientes.`,
      severity: 'WARNING',
      branchId: null,
      occurredAt: new Date(row.completed_at ?? row.received_at).toISOString(),
    }));
  }

  private async operationEvents(
    tenantId: string,
  ): Promise<NotificationSourceEvent[]> {
    const rows = await this.dataSource.query<
      Array<{
        source_id: string;
        source_type: string;
        error_code: string | null;
        occurred_at: Date | string;
      }>
    >(
      `SELECT id AS source_id, 'DATA_EXPORT' AS source_type, error_code,
              updated_at AS occurred_at
       FROM data_exports WHERE tenant_id = ? AND status = 'FAILED'
         AND updated_at >= DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 7 DAY)
       UNION ALL
       SELECT order_id AS source_id, 'ORDER_FULFILLMENT' AS source_type,
              last_error_code AS error_code, updated_at AS occurred_at
       FROM customer_order_fulfillments WHERE tenant_id = ?
         AND status = 'RETRYABLE_FAILURE'
         AND updated_at >= DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 7 DAY)
       ORDER BY occurred_at DESC LIMIT 100`,
      [tenantId, tenantId],
    );
    return rows.map((row) => ({
      eventType: 'OPERATION_FAILED',
      sourceKey: `operation:${row.source_type}:${row.source_id}:${new Date(row.occurred_at).toISOString()}`,
      title: 'Proceso operativo con fallo reintentable',
      body: `${row.source_type} requiere atención${row.error_code ? ` (${row.error_code})` : ''}.`,
      severity: 'WARNING',
      branchId: null,
      occurredAt: new Date(row.occurred_at).toISOString(),
    }));
  }

  private digest(
    eventType: NotificationEventType,
    events: NotificationSourceEvent[],
  ): NotificationSourceEvent {
    const latest = [...events].sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt),
    )[0];
    const day = new Date().toISOString().slice(0, 10);
    return {
      eventType,
      sourceKey: `digest:${eventType}:${day}`,
      title: `${events.length} aviso(s): ${this.eventLabel(eventType)}`,
      body: `Resumen diario con ${events.length} evento(s). Último: ${latest.title}.`,
      severity: events.some(({ severity }) => severity === 'CRITICAL')
        ? 'CRITICAL'
        : latest.severity,
      branchId: null,
      occurredAt: latest.occurredAt,
    };
  }

  private eventLabel(eventType: NotificationEventType): string {
    return {
      STOCK_LOW: 'stock bajo o agotado',
      LOT_EXPIRING: 'lotes por vencer',
      PURCHASE_PENDING: 'compras pendientes',
      CASH_DIFFERENCE: 'diferencias de caja',
      SYNC_FAILED: 'fallos de sincronización',
      OPERATION_FAILED: 'procesos con error',
    }[eventType];
  }

  private toPreference(row: PreferenceRow): NotificationPreferenceData {
    return {
      id: row.id,
      recipient: { id: row.recipient_user_id, email: row.email },
      eventType: row.event_type,
      enabled: Boolean(row.enabled),
      channels: {
        inApp: Boolean(row.in_app_enabled),
        email: Boolean(row.email_enabled),
        push: Boolean(row.push_enabled),
      },
      frequency: row.frequency,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private toNotification(row: NotificationRow): NotificationData {
    return {
      id: row.id,
      eventType: row.event_type,
      title: row.title,
      body: row.body,
      severity: row.severity,
      digestCount: Number(row.digest_count),
      sourceOccurredAt: new Date(row.source_occurred_at).toISOString(),
      readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private toDelivery(row: DeliveryRow): NotificationDeliveryData {
    return {
      id: row.id,
      notificationId: row.notification_id,
      recipient: { id: row.recipient_user_id, email: row.email },
      eventType: row.event_type,
      title: row.title,
      channel: row.channel,
      adapter: row.adapter,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
      errorCode: row.error_code,
      deliveredAt: row.delivered_at
        ? new Date(row.delivered_at).toISOString()
        : null,
    };
  }

  private dateOnly(value: Date | string): string {
    return value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
  }
}

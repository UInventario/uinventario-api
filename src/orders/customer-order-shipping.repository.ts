import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type {
  CarrierTrackingEvent,
  CustomerOrderCarrierPayload,
} from './customer-order-carrier.adapter';
import {
  CustomerOrderIdempotencyConflictError,
  CustomerOrderNotFoundError,
  CustomerOrderStateError,
} from './customer-order.errors';

interface ShippingRow {
  order_number: string;
  currency: string;
  method: 'PICKUP' | 'DELIVERY';
  carrier_code: 'SIMULATED' | 'SIMULATED_RETRY' | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  window_start: Date | string;
  window_end: Date | string;
  tracking_reference: string | null;
  tracking_status: CarrierTrackingEvent['status'] | null;
  latest_event_sequence: number | string;
}

interface ActionRow {
  order_id: string;
  action: 'CANCEL' | 'POLL';
  request_fingerprint: string;
}

@Injectable()
export class CustomerOrderShippingRepository {
  constructor(private readonly dataSource: DataSource) {}

  async payload(
    tenantId: string,
    branchId: string,
    orderId: string,
  ): Promise<CustomerOrderCarrierPayload> {
    const row = await this.state(
      this.dataSource.manager,
      tenantId,
      branchId,
      orderId,
      false,
    );
    if (!row) throw new CustomerOrderNotFoundError();
    this.assertDelivery(row);
    const parcels = await this.dataSource.query<
      Array<{ sku: string; quantity: string }>
    >(
      `SELECT product.sku, line.quantity
       FROM customer_order_lines line
       INNER JOIN products product
         ON product.id = line.product_id AND product.tenant_id = line.tenant_id
       WHERE line.tenant_id = ? AND line.order_id = ?
       ORDER BY line.line_number`,
      [tenantId, orderId],
    );
    return this.mapPayload(row, parcels);
  }

  async cancel(input: {
    tenantId: string;
    branchId: string;
    orderId: string;
    idempotencyKey: string;
    scenario: 'SUCCESS' | 'TIMEOUT';
    execute: (
      trackingReference: string,
    ) => Promise<
      | { status: 'CANCELLED' }
      | { status: 'FAILED_RETRYABLE'; errorCode: string }
    >;
  }): Promise<{ replay: boolean }> {
    const fingerprint = this.hash({
      orderId: input.orderId,
      action: 'CANCEL',
      scenario: input.scenario,
    });
    return this.dataSource.transaction(async (manager) => {
      await this.lockTenant(manager, input.tenantId);
      const replay = await this.actionReplay(
        manager,
        input.tenantId,
        input.orderId,
        'CANCEL',
        input.idempotencyKey,
        fingerprint,
      );
      if (replay) return { replay: true };
      const current = await this.state(
        manager,
        input.tenantId,
        input.branchId,
        input.orderId,
        true,
      );
      if (!current) throw new CustomerOrderNotFoundError();
      if (!current.tracking_reference)
        throw new CustomerOrderStateError('SHIPMENT_NOT_CREATED');
      if (current.tracking_status === 'DELIVERED')
        throw new CustomerOrderStateError('SHIPMENT_ALREADY_DELIVERED');
      const result = await input.execute(current.tracking_reference);
      await manager.query(
        `UPDATE customer_order_fulfillments
         SET status = CASE WHEN ? = 'CANCELLED' THEN 'READY' ELSE status END,
             tracking_status = CASE WHEN ? = 'CANCELLED' THEN 'CANCELLED' ELSE tracking_status END,
             manual_action_required = ?, last_error_code = ?
         WHERE tenant_id = ? AND order_id = ?`,
        [
          result.status,
          result.status,
          result.status === 'FAILED_RETRYABLE',
          result.status === 'FAILED_RETRYABLE' ? result.errorCode : null,
          input.tenantId,
          input.orderId,
        ],
      );
      await this.saveAction(manager, {
        ...input,
        action: 'CANCEL',
        fingerprint,
        result,
      });
      return { replay: false };
    });
  }

  async poll(input: {
    tenantId: string;
    branchId: string;
    orderId: string;
    idempotencyKey: string;
    scenario: 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'TIMEOUT';
    execute: (
      trackingReference: string,
      currentSequence: number,
    ) => Promise<
      | { status: 'SUCCEEDED'; event: CarrierTrackingEvent }
      | { status: 'FAILED_RETRYABLE'; errorCode: string }
    >;
  }): Promise<{ replay: boolean; eventApplied: boolean }> {
    const fingerprint = this.hash({
      orderId: input.orderId,
      action: 'POLL',
      scenario: input.scenario,
    });
    return this.dataSource.transaction(async (manager) => {
      await this.lockTenant(manager, input.tenantId);
      const replay = await this.actionReplay(
        manager,
        input.tenantId,
        input.orderId,
        'POLL',
        input.idempotencyKey,
        fingerprint,
      );
      if (replay) return { replay: true, eventApplied: false };
      const current = await this.state(
        manager,
        input.tenantId,
        input.branchId,
        input.orderId,
        true,
      );
      if (!current) throw new CustomerOrderNotFoundError();
      if (!current.tracking_reference)
        throw new CustomerOrderStateError('SHIPMENT_NOT_CREATED');
      if (current.tracking_status === 'CANCELLED')
        throw new CustomerOrderStateError('SHIPMENT_CANCELLED');
      const result = await input.execute(
        current.tracking_reference,
        Number(current.latest_event_sequence),
      );
      let eventApplied = false;
      if (result.status === 'FAILED_RETRYABLE') {
        await manager.query(
          `UPDATE customer_order_fulfillments
           SET last_error_code = ?, manual_action_required = TRUE
           WHERE tenant_id = ? AND order_id = ?`,
          [result.errorCode, input.tenantId, input.orderId],
        );
      } else {
        eventApplied = await this.insertEvent(
          manager,
          input.tenantId,
          input.orderId,
          'POLLING',
          result.event,
        );
      }
      await this.saveAction(manager, {
        ...input,
        action: 'POLL',
        fingerprint,
        result,
      });
      return { replay: false, eventApplied };
    });
  }

  async event(input: {
    tenantId: string;
    branchId: string;
    orderId: string;
    event: CarrierTrackingEvent;
  }): Promise<{ replay: boolean; applied: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockTenant(manager, input.tenantId);
      const [existing] = await manager.query<
        Array<{
          order_id: string;
          tracking_reference: string;
          status: string;
          sequence_number: number | string;
          applied: number | boolean;
        }>
      >(
        `SELECT order_id, tracking_reference, status, sequence_number, applied
         FROM customer_order_carrier_events
         WHERE tenant_id = ? AND provider_event_id = ? LIMIT 1`,
        [input.tenantId, input.event.providerEventId],
      );
      if (existing) {
        if (
          existing.order_id !== input.orderId ||
          existing.tracking_reference !== input.event.trackingReference ||
          existing.status !== input.event.status ||
          Number(existing.sequence_number) !== input.event.sequence
        )
          throw new CustomerOrderIdempotencyConflictError();
        return { replay: true, applied: Boolean(existing.applied) };
      }
      const current = await this.state(
        manager,
        input.tenantId,
        input.branchId,
        input.orderId,
        true,
      );
      if (!current) throw new CustomerOrderNotFoundError();
      if (!current.tracking_reference)
        throw new CustomerOrderStateError('SHIPMENT_NOT_CREATED');
      if (current.tracking_reference !== input.event.trackingReference)
        throw new CustomerOrderStateError('SHIPMENT_REFERENCE_MISMATCH');
      const applied = await this.insertEvent(
        manager,
        input.tenantId,
        input.orderId,
        'WEBHOOK',
        input.event,
      );
      return { replay: false, applied };
    });
  }

  private async insertEvent(
    manager: EntityManager,
    tenantId: string,
    orderId: string,
    source: 'WEBHOOK' | 'POLLING',
    event: CarrierTrackingEvent,
  ): Promise<boolean> {
    const [current] = await manager.query<
      Array<{
        latest_event_sequence: number | string;
        tracking_status: CarrierTrackingEvent['status'] | null;
      }>
    >(
      `SELECT latest_event_sequence, tracking_status FROM customer_order_fulfillments
       WHERE tenant_id = ? AND order_id = ? FOR UPDATE`,
      [tenantId, orderId],
    );
    const terminal = ['DELIVERED', 'CANCELLED'].includes(
      current.tracking_status ?? '',
    );
    const applied =
      !terminal && event.sequence > Number(current.latest_event_sequence);
    await manager.query(
      `INSERT INTO customer_order_carrier_events
       (id, tenant_id, order_id, provider_event_id, tracking_reference,
        source, status, sequence_number, occurred_at, applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        tenantId,
        orderId,
        event.providerEventId,
        event.trackingReference,
        source,
        event.status,
        event.sequence,
        new Date(event.occurredAt),
        applied,
      ],
    );
    if (applied) {
      await manager.query(
        `UPDATE customer_order_fulfillments
         SET tracking_status = ?, latest_event_sequence = ?, latest_event_at = ?,
             last_error_code = CASE WHEN ? = 'EXCEPTION' THEN 'CARRIER_EXCEPTION' ELSE NULL END,
             manual_action_required = (? = 'EXCEPTION')
         WHERE tenant_id = ? AND order_id = ?`,
        [
          event.status,
          event.sequence,
          new Date(event.occurredAt),
          event.status,
          event.status,
          tenantId,
          orderId,
        ],
      );
    }
    return applied;
  }

  private async state(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    orderId: string,
    lock: boolean,
  ): Promise<ShippingRow | undefined> {
    const [row] = await manager.query<ShippingRow[]>(
      `SELECT order_data.order_number, order_data.currency, fulfillment.*
       FROM customer_orders order_data
       INNER JOIN customer_order_fulfillments fulfillment
         ON fulfillment.order_id = order_data.id
         AND fulfillment.tenant_id = order_data.tenant_id
       WHERE order_data.tenant_id = ? AND order_data.branch_id = ? AND order_data.id = ?
       LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [tenantId, branchId, orderId],
    );
    return row;
  }

  private assertDelivery(row: ShippingRow): void {
    if (
      row.method !== 'DELIVERY' ||
      !row.carrier_code ||
      !row.recipient_name ||
      !row.recipient_phone ||
      !row.address_line1 ||
      !row.city ||
      !row.region ||
      !row.postal_code ||
      !row.country_code
    )
      throw new CustomerOrderStateError('CARRIER_NOT_CONFIGURED');
  }

  private mapPayload(
    row: ShippingRow,
    parcels: Array<{ sku: string; quantity: string }>,
  ): CustomerOrderCarrierPayload {
    this.assertDelivery(row);
    return {
      carrierCode: row.carrier_code!,
      orderNumber: row.order_number,
      currency: row.currency,
      windowStart: new Date(row.window_start).toISOString(),
      windowEnd: new Date(row.window_end).toISOString(),
      recipient: { name: row.recipient_name!, phone: row.recipient_phone! },
      address: {
        line1: row.address_line1!,
        line2: row.address_line2,
        city: row.city!,
        region: row.region!,
        postalCode: row.postal_code!,
        countryCode: row.country_code!,
      },
      parcels,
    };
  }

  private async actionReplay(
    manager: EntityManager,
    tenantId: string,
    orderId: string,
    action: 'CANCEL' | 'POLL',
    key: string,
    fingerprint: string,
  ): Promise<boolean> {
    const [row] = await manager.query<ActionRow[]>(
      `SELECT order_id, action, request_fingerprint
       FROM customer_order_shipping_actions
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    if (!row) return false;
    if (
      row.order_id !== orderId ||
      row.action !== action ||
      row.request_fingerprint !== fingerprint
    )
      throw new CustomerOrderIdempotencyConflictError();
    return true;
  }

  private saveAction(
    manager: EntityManager,
    input: {
      tenantId: string;
      orderId: string;
      action: 'CANCEL' | 'POLL';
      idempotencyKey: string;
      fingerprint: string;
      result: unknown;
    },
  ) {
    return manager.query(
      `INSERT INTO customer_order_shipping_actions
       (id, tenant_id, order_id, action, idempotency_key, request_fingerprint, result)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.tenantId,
        input.orderId,
        input.action,
        input.idempotencyKey,
        input.fingerprint,
        JSON.stringify(input.result),
      ],
    );
  }

  private lockTenant(manager: EntityManager, tenantId: string) {
    return manager.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [
      tenantId,
    ]);
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}

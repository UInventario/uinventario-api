import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { QuoteCartLineDto } from '../pos/dto/quote-cart.dto';
import type { PaymentMethod } from '../pos/dto/create-sale.dto';
import type { PosCartQuoteResponse } from '../pos/pos.types';
import {
  CustomerOrderIdempotencyConflictError,
  CustomerOrderNotFoundError,
  CustomerOrderReservationUnavailableError,
  CustomerOrderStateError,
  CustomerOrderVersionConflictError,
} from './customer-order.errors';
import type {
  CustomerOrderData,
  CustomerOrderPriority,
  CustomerOrderStatus,
} from './customer-order.types';
import type { ListCustomerOrdersDto } from './dto/list-customer-orders.dto';
import type { CustomerOrderDispatchResult } from './customer-order-carrier.adapter';

interface OrderRow {
  id: string;
  tenant_id: string;
  order_number: string;
  channel: CustomerOrderData['channel'];
  priority: CustomerOrderPriority;
  status: CustomerOrderStatus;
  version: number;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  expires_in_hours: number;
  reservation_id: string | null;
  reservation_number: string | null;
  reservation_status: string | null;
  sale_id: string | null;
  receipt_number: string | null;
  cancellation_reason: string | null;
  customer_id: string;
  customer_name: string;
  customer_identifier: string | null;
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
  fulfillment_method: 'PICKUP' | 'DELIVERY';
  fulfillment_status: CustomerOrderData['fulfillment']['status'];
  recipient_name: string | null;
  recipient_phone: string | null;
  fulfillment_city: string | null;
  fulfillment_region: string | null;
  fulfillment_country_code: string | null;
  carrier_code: 'SIMULATED' | 'SIMULATED_RETRY' | null;
  carrier_name: string | null;
  delivery_cost: string;
  window_start: Date | string;
  window_end: Date | string;
  tracking_reference: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_attempt_at: Date | string | null;
  assigned_user_id: string | null;
  assigned_user_email: string | null;
  delivered_user_id: string | null;
  delivered_user_email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PlannedPayment {
  method: PaymentMethod;
  amount: string;
  amountReceived: string;
  reference: string | null;
}

@Injectable()
export class CustomerOrderRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    locationId: string;
    customerId: string;
    channel: CustomerOrderData['channel'];
    priority: CustomerOrderPriority;
    expiresInHours: number;
    lines: QuoteCartLineDto[];
    payments: PlannedPayment[];
    quote: PosCartQuoteResponse['data'];
    idempotencyKey: string;
    fingerprint: string;
    fulfillment: {
      method: 'PICKUP' | 'DELIVERY';
      deliveryCost: string;
      windowStart: Date;
      windowEnd: Date;
      recipientName: string | null;
      recipientPhone: string | null;
      addressLine1: string | null;
      addressLine2: string | null;
      city: string | null;
      region: string | null;
      postalCode: string | null;
      countryCode: string | null;
      carrierCode: 'SIMULATED' | 'SIMULATED_RETRY' | null;
      carrierName: string | null;
    };
  }): Promise<{ order: CustomerOrderData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const replay = await this.findByCreateKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.request_fingerprint !== input.fingerprint)
              throw new CustomerOrderIdempotencyConflictError();
            const order = await this.findById(
              manager,
              input.tenantId,
              input.branchId,
              replay.id,
            );
            if (!order) throw new CustomerOrderNotFoundError();
            return { order, replay: true };
          }
          const [target] = await manager.query<Array<{ id: string }>>(
            `SELECT l.id FROM branches b
           INNER JOIN warehouses w ON w.id = ? AND w.branch_id = b.id AND w.tenant_id = b.tenant_id
           INNER JOIN locations l ON l.id = ? AND l.warehouse_id = w.id AND l.tenant_id = w.tenant_id
           INNER JOIN cash_registers cr ON cr.id = ? AND cr.branch_id = b.id AND cr.tenant_id = b.tenant_id
           INNER JOIN customers c ON c.id = ? AND c.tenant_id = b.tenant_id AND c.active = TRUE
           WHERE b.id = ? AND b.tenant_id = ? AND b.active = TRUE AND w.active = TRUE AND l.active = TRUE
           LIMIT 1 FOR UPDATE`,
            [
              input.warehouseId,
              input.locationId,
              input.cashRegisterId,
              input.customerId,
              input.branchId,
              input.tenantId,
            ],
          );
          if (!target) throw new CustomerOrderNotFoundError();
          const id = randomUUID();
          const orderNumber = `O-${id.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
          await manager.query(
            `INSERT INTO customer_orders
            (id, tenant_id, branch_id, warehouse_id, cash_register_id, location_id,
             customer_id, order_number, channel, priority, status, currency,
             subtotal, tax, total, expires_in_hours, idempotency_key,
             request_fingerprint, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              input.tenantId,
              input.branchId,
              input.warehouseId,
              input.cashRegisterId,
              input.locationId,
              input.customerId,
              orderNumber,
              input.channel,
              input.priority,
              input.quote.currency,
              input.quote.totals.subtotal,
              input.quote.totals.tax,
              input.quote.totals.total,
              input.expiresInHours,
              input.idempotencyKey,
              input.fingerprint,
              input.userId,
            ],
          );
          await manager.query(
            `INSERT INTO customer_order_fulfillments
            (order_id, tenant_id, method, status, recipient_name, recipient_phone,
             address_line1, address_line2, city, region, postal_code, country_code,
             carrier_code, carrier_name, delivery_cost, window_start, window_end)
           VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              input.tenantId,
              input.fulfillment.method,
              input.fulfillment.recipientName,
              input.fulfillment.recipientPhone,
              input.fulfillment.addressLine1,
              input.fulfillment.addressLine2,
              input.fulfillment.city,
              input.fulfillment.region,
              input.fulfillment.postalCode,
              input.fulfillment.countryCode,
              input.fulfillment.carrierCode,
              input.fulfillment.carrierName,
              input.fulfillment.deliveryCost,
              input.fulfillment.windowStart,
              input.fulfillment.windowEnd,
            ],
          );
          for (const [index, quoted] of input.quote.lines.entries()) {
            const requested = input.lines.find(
              ({ productId }) => productId === quoted.product.id,
            )!;
            await manager.query(
              `INSERT INTO customer_order_lines
              (id, tenant_id, order_id, line_number, product_id, lot_id, quantity,
               serial_numbers, unit_price, gross_total, discount_total, subtotal, tax, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                id,
                index + 1,
                quoted.product.id,
                requested.lotId ?? null,
                quoted.quantity,
                JSON.stringify(requested.serialNumbers ?? []),
                quoted.unitPrice,
                quoted.grossTotal,
                quoted.discount.total,
                quoted.subtotal,
                quoted.tax,
                quoted.total,
              ],
            );
          }
          for (const [index, payment] of input.payments.entries()) {
            await manager.query(
              `INSERT INTO customer_order_payments
              (id, tenant_id, order_id, line_number, method, amount,
               amount_received, reference, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED')`,
              [
                randomUUID(),
                input.tenantId,
                id,
                index + 1,
                payment.method,
                payment.amount,
                payment.amountReceived,
                payment.reference,
              ],
            );
          }
          const order = await this.findById(
            manager,
            input.tenantId,
            input.branchId,
            id,
          );
          if (!order) throw new CustomerOrderNotFoundError();
          return { order, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByCreateKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay || replay.request_fingerprint !== input.fingerprint)
        throw new CustomerOrderIdempotencyConflictError();
      const order = await this.findById(
        this.dataSource.manager,
        input.tenantId,
        input.branchId,
        replay.id,
      );
      if (!order) throw new CustomerOrderNotFoundError();
      return { order, replay: true };
    }
  }

  async list(
    tenantId: string,
    branchId: string,
    query: ListCustomerOrdersDto,
  ): Promise<{ orders: CustomerOrderData[]; total: number }> {
    const filters = ['o.tenant_id = ?', 'o.branch_id = ?'];
    const values: unknown[] = [tenantId, branchId];
    if (query.status) {
      filters.push('o.status = ?');
      values.push(query.status);
    }
    if (query.priority) {
      filters.push('o.priority = ?');
      values.push(query.priority);
    }
    const where = `WHERE ${filters.join(' AND ')}`;
    const [count] = await this.dataSource.query<
      Array<{ total: number | string }>
    >(`SELECT COUNT(*) AS total FROM customer_orders o ${where}`, values);
    const rows = await this.rows(
      this.dataSource.manager,
      `${where}
       ORDER BY FIELD(o.priority, 'URGENT', 'HIGH', 'NORMAL', 'LOW'), o.created_at
       LIMIT ? OFFSET ?`,
      [...values, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      orders: await Promise.all(
        rows.map((row) => this.data(this.dataSource.manager, row)),
      ),
      total: Number(count?.total ?? 0),
    };
  }

  find(
    tenantId: string,
    branchId: string,
    orderId: string,
  ): Promise<CustomerOrderData | null> {
    return this.findById(this.dataSource.manager, tenantId, branchId, orderId);
  }

  async findByIdempotency(
    tenantId: string,
    branchId: string,
    key: string,
  ): Promise<{ order: CustomerOrderData; fingerprint: string } | null> {
    const row = await this.findByCreateKey(
      this.dataSource.manager,
      tenantId,
      key,
    );
    if (!row) return null;
    const order = await this.findById(
      this.dataSource.manager,
      tenantId,
      branchId,
      row.id,
    );
    return order ? { order, fingerprint: row.request_fingerprint } : null;
  }

  async findDispatchByIdempotency(input: {
    tenantId: string;
    branchId: string;
    orderId: string;
    version: number;
    idempotencyKey: string;
  }): Promise<CustomerOrderData | null> {
    const replay = await this.findDispatch(
      this.dataSource.manager,
      input.tenantId,
      input.idempotencyKey,
    );
    if (!replay) return null;
    if (
      replay.order_id !== input.orderId ||
      replay.request_fingerprint !==
        this.dispatchFingerprint(input.orderId, input.version)
    )
      throw new CustomerOrderIdempotencyConflictError();
    const order = await this.findById(
      this.dataSource.manager,
      input.tenantId,
      input.branchId,
      input.orderId,
    );
    if (!order) throw new CustomerOrderNotFoundError();
    return order;
  }

  async transition(input: {
    tenantId: string;
    branchId: string;
    orderId: string;
    actorUserId: string;
    version: number;
    idempotencyKey: string;
    from: CustomerOrderStatus[];
    to: CustomerOrderStatus;
    reason?: string;
    reservationId?: string;
    saleId?: string;
  }): Promise<{ order: CustomerOrderData; replay: boolean }> {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          orderId: input.orderId,
          version: input.version,
          to: input.to,
          reason: input.reason?.trim() ?? null,
        }),
      )
      .digest('hex');
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const replay = await this.findTransition(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (
              replay.request_fingerprint !== fingerprint ||
              replay.order_id !== input.orderId
            )
              throw new CustomerOrderIdempotencyConflictError();
            const order = await this.findById(
              manager,
              input.tenantId,
              input.branchId,
              input.orderId,
            );
            if (!order) throw new CustomerOrderNotFoundError();
            return { order, replay: true };
          }
          const [current] = await manager.query<
            Array<{
              status: CustomerOrderStatus;
              version: number;
              reservation_id: string | null;
            }>
          >(
            `SELECT status, version, reservation_id FROM customer_orders
           WHERE id = ? AND tenant_id = ? AND branch_id = ? FOR UPDATE`,
            [input.orderId, input.tenantId, input.branchId],
          );
          if (!current) throw new CustomerOrderNotFoundError();
          if (!input.from.includes(current.status))
            throw new CustomerOrderStateError(current.status);
          if (Number(current.version) !== input.version)
            throw new CustomerOrderVersionConflictError();
          if (['PREPARING', 'READY'].includes(input.to)) {
            const [reservation] = await manager.query<Array<{ id: string }>>(
              `SELECT id FROM product_reservations
             WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'
               AND expires_at > CURRENT_TIMESTAMP(6) FOR UPDATE`,
              [current.reservation_id, input.tenantId],
            );
            if (!reservation)
              throw new CustomerOrderReservationUnavailableError();
          }
          await manager.query(
            `UPDATE customer_orders SET status = ?, version = version + 1,
             reservation_id = COALESCE(?, reservation_id), sale_id = COALESCE(?, sale_id),
             confirmed_at = IF(? = 'CONFIRMED', CURRENT_TIMESTAMP(6), confirmed_at),
             preparing_at = IF(? = 'PREPARING', CURRENT_TIMESTAMP(6), preparing_at),
             ready_at = IF(? = 'READY', CURRENT_TIMESTAMP(6), ready_at),
             delivered_at = IF(? = 'DELIVERED', CURRENT_TIMESTAMP(6), delivered_at),
             cancelled_at = IF(? = 'CANCELLED', CURRENT_TIMESTAMP(6), cancelled_at),
             cancellation_reason = IF(? = 'CANCELLED', ?, cancellation_reason)
           WHERE id = ? AND tenant_id = ?`,
            [
              input.to,
              input.reservationId ?? null,
              input.saleId ?? null,
              input.to,
              input.to,
              input.to,
              input.to,
              input.to,
              input.to,
              input.reason?.trim() ?? null,
              input.orderId,
              input.tenantId,
            ],
          );
          if (input.to === 'PREPARING') {
            await manager.query(
              `UPDATE customer_order_fulfillments
               SET status = 'PREPARING', assigned_user_id = COALESCE(assigned_user_id, ?)
               WHERE order_id = ? AND tenant_id = ?`,
              [input.actorUserId, input.orderId, input.tenantId],
            );
          } else if (input.to === 'READY') {
            await manager.query(
              `UPDATE customer_order_fulfillments SET status = 'READY'
               WHERE order_id = ? AND tenant_id = ?`,
              [input.orderId, input.tenantId],
            );
          } else if (input.to === 'DELIVERED') {
            await manager.query(
              `UPDATE customer_order_fulfillments
               SET status = 'DELIVERED', delivered_user_id = ?
               WHERE order_id = ? AND tenant_id = ?`,
              [input.actorUserId, input.orderId, input.tenantId],
            );
          } else if (input.to === 'CANCELLED') {
            await manager.query(
              `UPDATE customer_order_fulfillments SET status = 'CANCELLED'
               WHERE order_id = ? AND tenant_id = ?`,
              [input.orderId, input.tenantId],
            );
          }
          if (input.to === 'DELIVERED') {
            await manager.query(
              `UPDATE customer_order_payments SET status = 'COMPLETED'
             WHERE order_id = ? AND tenant_id = ?`,
              [input.orderId, input.tenantId],
            );
          } else if (input.to === 'CANCELLED') {
            await manager.query(
              `UPDATE customer_order_payments SET status = 'CANCELLED'
             WHERE order_id = ? AND tenant_id = ?`,
              [input.orderId, input.tenantId],
            );
          }
          await manager.query(
            `INSERT INTO customer_order_transitions
            (id, tenant_id, order_id, from_status, to_status, reason,
             actor_user_id, idempotency_key, request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              input.tenantId,
              input.orderId,
              current.status,
              input.to,
              input.reason?.trim() ?? null,
              input.actorUserId,
              input.idempotencyKey,
              fingerprint,
            ],
          );
          const order = await this.findById(
            manager,
            input.tenantId,
            input.branchId,
            input.orderId,
          );
          if (!order) throw new CustomerOrderNotFoundError();
          return { order, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findTransition(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (
        !replay ||
        replay.request_fingerprint !== fingerprint ||
        replay.order_id !== input.orderId
      )
        throw new CustomerOrderIdempotencyConflictError();
      const order = await this.findById(
        this.dataSource.manager,
        input.tenantId,
        input.branchId,
        input.orderId,
      );
      if (!order) throw new CustomerOrderNotFoundError();
      return { order, replay: true };
    }
  }

  async dispatch(input: {
    tenantId: string;
    branchId: string;
    orderId: string;
    actorUserId: string;
    version: number;
    idempotencyKey: string;
    result: CustomerOrderDispatchResult;
  }): Promise<{ order: CustomerOrderData; replay: boolean }> {
    const fingerprint = this.dispatchFingerprint(input.orderId, input.version);
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const replay = await this.findDispatch(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (
              replay.request_fingerprint !== fingerprint ||
              replay.order_id !== input.orderId
            )
              throw new CustomerOrderIdempotencyConflictError();
            const order = await this.findById(
              manager,
              input.tenantId,
              input.branchId,
              input.orderId,
            );
            if (!order) throw new CustomerOrderNotFoundError();
            return { order, replay: true };
          }
          const [current] = await manager.query<
            Array<{
              status: CustomerOrderStatus;
              version: number;
              method: 'PICKUP' | 'DELIVERY';
              fulfillment_status: CustomerOrderData['fulfillment']['status'];
              carrier_code: 'SIMULATED' | 'SIMULATED_RETRY' | null;
              attempt_count: number;
            }>
          >(
            `SELECT o.status, o.version, f.method,
                    f.status AS fulfillment_status, f.carrier_code, f.attempt_count
             FROM customer_orders o
             INNER JOIN customer_order_fulfillments f
               ON f.order_id = o.id AND f.tenant_id = o.tenant_id
             WHERE o.id = ? AND o.tenant_id = ? AND o.branch_id = ? FOR UPDATE`,
            [input.orderId, input.tenantId, input.branchId],
          );
          if (!current) throw new CustomerOrderNotFoundError();
          if (
            current.status !== 'READY' ||
            current.method !== 'DELIVERY' ||
            !['READY', 'RETRYABLE_FAILURE'].includes(current.fulfillment_status)
          )
            throw new CustomerOrderStateError(current.fulfillment_status);
          if (Number(current.version) !== input.version)
            throw new CustomerOrderVersionConflictError();
          const attempt = Number(current.attempt_count) + 1;
          await manager.query(
            `INSERT INTO customer_order_dispatch_attempts
            (id, tenant_id, order_id, attempt_number, status, carrier_code,
             tracking_reference, error_code, actor_user_id, idempotency_key,
             request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              input.tenantId,
              input.orderId,
              attempt,
              input.result.status,
              current.carrier_code,
              input.result.status === 'SUCCEEDED'
                ? input.result.trackingReference
                : null,
              input.result.status === 'FAILED_RETRYABLE'
                ? input.result.errorCode
                : null,
              input.actorUserId,
              input.idempotencyKey,
              fingerprint,
            ],
          );
          await manager.query(
            `UPDATE customer_order_fulfillments
             SET status = ?, attempt_count = ?, tracking_reference = ?,
                 last_error_code = ?, last_attempt_at = CURRENT_TIMESTAMP(6)
             WHERE order_id = ? AND tenant_id = ?`,
            [
              input.result.status === 'SUCCEEDED'
                ? 'DISPATCHED'
                : 'RETRYABLE_FAILURE',
              attempt,
              input.result.status === 'SUCCEEDED'
                ? input.result.trackingReference
                : null,
              input.result.status === 'FAILED_RETRYABLE'
                ? input.result.errorCode
                : null,
              input.orderId,
              input.tenantId,
            ],
          );
          await manager.query(
            `UPDATE customer_orders SET version = version + 1
             WHERE id = ? AND tenant_id = ?`,
            [input.orderId, input.tenantId],
          );
          const order = await this.findById(
            manager,
            input.tenantId,
            input.branchId,
            input.orderId,
          );
          if (!order) throw new CustomerOrderNotFoundError();
          return { order, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findDispatch(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (
        !replay ||
        replay.request_fingerprint !== fingerprint ||
        replay.order_id !== input.orderId
      )
        throw new CustomerOrderIdempotencyConflictError();
      const order = await this.findById(
        this.dataSource.manager,
        input.tenantId,
        input.branchId,
        input.orderId,
      );
      if (!order) throw new CustomerOrderNotFoundError();
      return { order, replay: true };
    }
  }

  private async findByCreateKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ) {
    const [row] = await manager.query<
      Array<{ id: string; request_fingerprint: string }>
    >(
      'SELECT id, request_fingerprint FROM customer_orders WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1',
      [tenantId, key],
    );
    return row;
  }

  private async findTransition(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ) {
    const [row] = await manager.query<
      Array<{ order_id: string; request_fingerprint: string }>
    >(
      'SELECT order_id, request_fingerprint FROM customer_order_transitions WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1',
      [tenantId, key],
    );
    return row;
  }

  private async findDispatch(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ) {
    const [row] = await manager.query<
      Array<{ order_id: string; request_fingerprint: string }>
    >(
      `SELECT order_id, request_fingerprint
       FROM customer_order_dispatch_attempts
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    return row;
  }

  private dispatchFingerprint(orderId: string, version: number): string {
    return createHash('sha256')
      .update(JSON.stringify({ orderId, version, action: 'dispatch' }))
      .digest('hex');
  }

  private async findById(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    orderId: string,
  ): Promise<CustomerOrderData | null> {
    const [row] = await this.rows(
      manager,
      'WHERE o.id = ? AND o.tenant_id = ? AND o.branch_id = ? LIMIT 1',
      [orderId, tenantId, branchId],
    );
    return row ? this.data(manager, row) : null;
  }

  private rows(manager: EntityManager, suffix: string, values: unknown[]) {
    return manager.query<OrderRow[]>(
      `SELECT o.*, c.name AS customer_name, c.identifier AS customer_identifier,
              b.name AS branch_name, w.name AS warehouse_name,
              cr.name AS cash_register_name, cr.code AS cash_register_code,
              l.name AS location_name, l.code AS location_code,
              r.reservation_number, r.status AS reservation_status, s.receipt_number,
              f.method AS fulfillment_method, f.status AS fulfillment_status,
              f.recipient_name, f.recipient_phone,
              f.city AS fulfillment_city, f.region AS fulfillment_region,
              f.country_code AS fulfillment_country_code,
              f.carrier_code, f.carrier_name, f.delivery_cost,
              f.window_start, f.window_end, f.tracking_reference,
              f.attempt_count, f.last_error_code, f.last_attempt_at,
              au.id AS assigned_user_id, au.email AS assigned_user_email,
              du.id AS delivered_user_id, du.email AS delivered_user_email
       FROM customer_orders o
       INNER JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
       INNER JOIN branches b ON b.id = o.branch_id AND b.tenant_id = o.tenant_id
       INNER JOIN warehouses w ON w.id = o.warehouse_id AND w.tenant_id = o.tenant_id
       INNER JOIN cash_registers cr ON cr.id = o.cash_register_id AND cr.tenant_id = o.tenant_id
       INNER JOIN locations l ON l.id = o.location_id AND l.tenant_id = o.tenant_id
       LEFT JOIN product_reservations r ON r.id = o.reservation_id AND r.tenant_id = o.tenant_id
       LEFT JOIN sales s ON s.id = o.sale_id AND s.tenant_id = o.tenant_id
       INNER JOIN customer_order_fulfillments f
         ON f.order_id = o.id AND f.tenant_id = o.tenant_id
       LEFT JOIN users au ON au.id = f.assigned_user_id
       LEFT JOIN users du ON du.id = f.delivered_user_id
       ${suffix}`,
      values,
    );
  }

  private async data(
    manager: EntityManager,
    row: OrderRow,
  ): Promise<CustomerOrderData> {
    const [lines, payments, transitions] = await Promise.all([
      manager.query<
        Array<{
          id: string;
          product_id: string;
          product_name: string;
          product_sku: string;
          quantity: string;
          lot_id: string | null;
          serial_numbers: unknown;
          unit_price: string;
          gross_total: string;
          discount_total: string;
          subtotal: string;
          tax: string;
          total: string;
        }>
      >(
        `SELECT ol.*, p.name AS product_name, p.sku AS product_sku
         FROM customer_order_lines ol
         INNER JOIN products p ON p.id = ol.product_id AND p.tenant_id = ol.tenant_id
         WHERE ol.order_id = ? AND ol.tenant_id = ? ORDER BY ol.line_number`,
        [row.id, row.tenant_id],
      ),
      manager.query<
        Array<{
          id: string;
          method: PaymentMethod;
          amount: string;
          amount_received: string;
          reference: string | null;
          status: 'PLANNED' | 'COMPLETED' | 'CANCELLED';
        }>
      >(
        `SELECT id, method, amount, amount_received, reference, status
         FROM customer_order_payments WHERE order_id = ? AND tenant_id = ? ORDER BY line_number`,
        [row.id, row.tenant_id],
      ),
      manager.query<
        Array<{
          id: string;
          from_status: CustomerOrderStatus;
          to_status: CustomerOrderStatus;
          reason: string | null;
          actor_id: string;
          actor_email: string;
          created_at: Date | string;
        }>
      >(
        `SELECT ot.id, ot.from_status, ot.to_status, ot.reason,
                u.id AS actor_id, u.email AS actor_email, ot.created_at
         FROM customer_order_transitions ot
         INNER JOIN users u ON u.id = ot.actor_user_id
         WHERE ot.order_id = ? AND ot.tenant_id = ? ORDER BY ot.created_at, ot.id`,
        [row.id, row.tenant_id],
      ),
    ]);
    return {
      id: row.id,
      orderNumber: row.order_number,
      channel: row.channel,
      priority: row.priority,
      status: row.status,
      version: Number(row.version),
      customer: {
        id: row.customer_id,
        name: row.customer_name,
        identifier: row.customer_identifier,
      },
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
      },
      currency: row.currency,
      totals: { subtotal: row.subtotal, tax: row.tax, total: row.total },
      expiresInHours: Number(row.expires_in_hours),
      fulfillment: {
        method: row.fulfillment_method,
        status: row.fulfillment_status,
        deliveryCost: row.delivery_cost,
        window: {
          start: this.iso(row.window_start),
          end: this.iso(row.window_end),
        },
        address:
          row.fulfillment_method === 'DELIVERY'
            ? {
                recipientNameMasked: this.maskName(row.recipient_name!),
                phoneMasked: this.maskPhone(row.recipient_phone!),
                summary: [
                  row.fulfillment_city,
                  row.fulfillment_region,
                  row.fulfillment_country_code,
                ]
                  .filter(Boolean)
                  .join(', '),
                countryCode: row.fulfillment_country_code!,
              }
            : null,
        carrier:
          row.carrier_code && row.carrier_name
            ? {
                code: row.carrier_code,
                name: row.carrier_name,
                trackingReference: row.tracking_reference,
                attempts: Number(row.attempt_count),
                lastErrorCode: row.last_error_code,
                lastAttemptAt: row.last_attempt_at
                  ? this.iso(row.last_attempt_at)
                  : null,
              }
            : null,
        responsible: {
          preparation:
            row.assigned_user_id && row.assigned_user_email
              ? { id: row.assigned_user_id, email: row.assigned_user_email }
              : null,
          delivery:
            row.delivered_user_id && row.delivered_user_email
              ? { id: row.delivered_user_id, email: row.delivered_user_email }
              : null,
        },
      },
      reservation: row.reservation_id
        ? {
            id: row.reservation_id,
            reservationNumber: row.reservation_number!,
            status: row.reservation_status!,
          }
        : null,
      sale: row.sale_id
        ? { id: row.sale_id, receiptNumber: row.receipt_number! }
        : null,
      lines: lines.map((line) => ({
        id: line.id,
        product: {
          id: line.product_id,
          name: line.product_name,
          sku: line.product_sku,
        },
        quantity: line.quantity,
        lotId: line.lot_id,
        serialNumbers: this.jsonStrings(line.serial_numbers),
        unitPrice: line.unit_price,
        grossTotal: line.gross_total,
        discountTotal: line.discount_total,
        subtotal: line.subtotal,
        tax: line.tax,
        total: line.total,
      })),
      payments: payments.map((payment) => ({
        id: payment.id,
        method: payment.method,
        amount: payment.amount,
        amountReceived: payment.amount_received,
        reference: payment.reference,
        status: payment.status,
      })),
      transitions: transitions.map((transition) => ({
        id: transition.id,
        fromStatus: transition.from_status,
        toStatus: transition.to_status,
        reason: transition.reason,
        actor: { id: transition.actor_id, email: transition.actor_email },
        createdAt: this.iso(transition.created_at),
      })),
      cancellationReason: row.cancellation_reason,
      createdAt: this.iso(row.created_at),
      updatedAt: this.iso(row.updated_at),
    };
  }

  private jsonStrings(value: unknown): string[] {
    const parsed =
      typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private iso(value: Date | string): string {
    return new Date(value).toISOString();
  }

  private maskPhone(value: string): string {
    const digits = value.replace(/\D/g, '');
    return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
  }

  private maskName(value: string): string {
    const trimmed = value.trim();
    return trimmed ? `${trimmed.slice(0, 1)}***` : '***';
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error as { driverError?: { code?: string } }).driverError?.code ===
        'ER_DUP_ENTRY'
    );
  }
}

import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { applyInventoryValuation } from '../inventory/inventory-valuation';
import { applyInventoryLotTracking } from '../inventory/inventory-lot-tracking';
import { applyInventorySerialTracking } from '../inventory/inventory-serial-tracking';
import { CreateProductReservationDto } from './dto/create-product-reservation.dto';
import {
  ProductReservationIdempotencyConflictError,
  ProductReservationInsufficientStockError,
  ProductReservationNotActiveError,
  ProductReservationTargetNotFoundError,
} from './product-reservation.errors';
import { ProductReservationData } from './product-reservation.types';

interface ReservationRow {
  id: string;
  tenant_id: string;
  reservation_number: string;
  status: 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'CONSUMED';
  request_fingerprint: string;
  expires_at: Date | string;
  created_at: Date | string;
  closed_at: Date | string | null;
  closure_reason: string | null;
  sale_id: string | null;
  receipt_number: string | null;
  customer_id: string;
  customer_name: string;
  customer_identifier: string | null;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  location_id: string;
  location_name: string;
  location_code: string;
  user_id: string;
  user_email: string;
}

@Injectable()
export class ProductReservationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string;
    dto: CreateProductReservationDto;
  }): Promise<{ reservation: ProductReservationData; replay: boolean }> {
    const canonicalLines = [...input.dto.lines]
      .map((line) => ({
        productId: line.productId,
        quantity: this.decimal(this.units(line.quantity)),
        serialNumbers: (line.serialNumbers ?? [])
          .map((value) => value.trim())
          .sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.productId.localeCompare(right.productId));
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: input.dto.customerId,
          locationId: input.dto.locationId,
          expiresInHours: input.dto.expiresInHours,
          lines: canonicalLines,
        }),
      )
      .digest('hex');
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const replay = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) return this.replay(replay, fingerprint);
          const [target] = await manager.query<Array<{ location_id: string }>>(
            `SELECT l.id AS location_id FROM branches b
           INNER JOIN warehouses w ON w.branch_id = b.id AND w.tenant_id = b.tenant_id
           INNER JOIN locations l ON l.warehouse_id = w.id AND l.tenant_id = w.tenant_id
           WHERE b.id = ? AND w.id = ? AND l.id = ? AND b.tenant_id = ?
             AND b.active = TRUE AND w.active = TRUE AND l.active = TRUE LIMIT 1 FOR UPDATE`,
            [
              input.branchId,
              input.warehouseId,
              input.dto.locationId,
              input.tenantId,
            ],
          );
          const [customer] = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM customers
           WHERE id = ? AND tenant_id = ? AND active = TRUE FOR UPDATE`,
            [input.dto.customerId, input.tenantId],
          );
          if (!target || !customer)
            throw new ProductReservationTargetNotFoundError();

          const id = randomUUID();
          const reservationNumber = `R-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
          const expiresAt = new Date(
            Date.now() + input.dto.expiresInHours * 60 * 60_000,
          );
          await manager.query(
            `INSERT INTO product_reservations
            (id, tenant_id, branch_id, warehouse_id, location_id, customer_id,
             reservation_number, status, expires_at, created_by_user_id,
             idempotency_key, request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
            [
              id,
              input.tenantId,
              input.branchId,
              input.warehouseId,
              input.dto.locationId,
              input.dto.customerId,
              reservationNumber,
              expiresAt,
              input.userId,
              input.idempotencyKey,
              fingerprint,
            ],
          );

          for (const [index, line] of canonicalLines.entries()) {
            const quantityUnits = this.units(line.quantity);
            if (quantityUnits <= 0n)
              throw new ProductReservationTargetNotFoundError();
            const [product] = await manager.query<Array<{ id: string }>>(
              `SELECT id FROM products
             WHERE id = ? AND tenant_id = ? AND active = TRUE LIMIT 1 FOR UPDATE`,
              [line.productId, input.tenantId],
            );
            if (!product) throw new ProductReservationTargetNotFoundError();
            const movementId = randomUUID();
            await manager.query(
              `INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity)
             VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE quantity = quantity`,
              [input.tenantId, line.productId, input.dto.locationId],
            );
            const [balance] = await manager.query<
              Array<{
                quantity: string;
                available_quantity: string;
                reserved_quantity: string;
              }>
            >(
              `SELECT quantity, available_quantity, reserved_quantity
             FROM inventory_balances
             WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
              [input.tenantId, line.productId, input.dto.locationId],
            );
            const available = this.units(balance.available_quantity);
            if (available < quantityUnits)
              throw new ProductReservationInsufficientStockError(
                line.productId,
              );
            const reservationLineId = randomUUID();
            await manager.query(
              `INSERT INTO product_reservation_lines
              (id, tenant_id, reservation_id, line_number, product_id, quantity,
               serial_numbers)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                reservationLineId,
                input.tenantId,
                id,
                index + 1,
                line.productId,
                line.quantity,
                JSON.stringify(line.serialNumbers),
              ],
            );
            await manager.query(
              `UPDATE inventory_balances
             SET available_quantity = ?, reserved_quantity = ?
             WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                this.decimal(available - quantityUnits),
                this.decimal(
                  this.units(balance.reserved_quantity) + quantityUnits,
                ),
                input.tenantId,
                line.productId,
                input.dto.locationId,
              ],
            );
            await manager.query(
              `INSERT INTO inventory_movements
              (id, tenant_id, product_id, location_id, type, from_state, to_state,
               state_quantity, quantity_change, resulting_quantity, reason, reference,
               idempotency_key, request_fingerprint, created_by_user_id,
               reservation_id, reservation_line_id)
             VALUES (?, ?, ?, ?, 'STATE_TRANSITION', 'AVAILABLE', 'RESERVED', ?, 0, ?,
                     'Reserva de cliente', ?, ?, ?, ?, ?, ?)`,
              [
                movementId,
                input.tenantId,
                line.productId,
                input.dto.locationId,
                line.quantity,
                balance.quantity,
                reservationNumber,
                `reservation:${id}:${index + 1}`,
                fingerprint,
                input.userId,
                id,
                reservationLineId,
              ],
            );
            await applyInventoryValuation(manager, movementId);
            await applyInventoryLotTracking(manager, movementId);
            await applyInventorySerialTracking(manager, movementId, {
              serialNumbers: line.serialNumbers,
            });
          }
          const reservation = await this.findById(manager, input.tenantId, id);
          if (!reservation) throw new Error('CREATED_RESERVATION_NOT_FOUND');
          return { reservation, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay) throw error;
      return this.replay(replay, fingerprint);
    }
  }

  async list(
    tenantId: string,
    branchId: string,
  ): Promise<ProductReservationData[]> {
    const rows = await this.rows(
      this.dataSource.manager,
      'WHERE r.tenant_id = ? AND r.branch_id = ?',
      [tenantId, branchId],
    );
    return Promise.all(
      rows.map((row) => this.data(this.dataSource.manager, row)),
    );
  }

  async release(input: {
    tenantId: string;
    branchId: string;
    userId: string;
    reservationId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<{ reservation: ProductReservationData; replay: boolean }> {
    const fingerprint = this.closeFingerprint('RELEASED', input.reason);
    try {
      return await this.dataSource.transaction('READ COMMITTED', (manager) =>
        this.close(manager, { ...input, status: 'RELEASED', fingerprint }),
      );
    } catch (error) {
      if (this.isDuplicate(error))
        throw new ProductReservationIdempotencyConflictError();
      throw error;
    }
  }

  async expireDue(input: {
    tenantId: string;
    branchId: string;
    userId: string;
  }): Promise<ProductReservationData[]> {
    const due = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM product_reservations
       WHERE tenant_id = ? AND branch_id = ? AND status = 'ACTIVE'
         AND expires_at <= CURRENT_TIMESTAMP(6)
       ORDER BY expires_at, id`,
      [input.tenantId, input.branchId],
    );
    const expired: ProductReservationData[] = [];
    for (const reservation of due) {
      const reason = 'Vencimiento automático';
      try {
        const result = await this.dataSource.transaction(
          'READ COMMITTED',
          (manager) =>
            this.close(manager, {
              ...input,
              reservationId: reservation.id,
              idempotencyKey: `expire:${reservation.id}`,
              reason,
              status: 'EXPIRED',
              fingerprint: this.closeFingerprint('EXPIRED', reason),
            }),
        );
        if (!result.replay) expired.push(result.reservation);
      } catch (error) {
        if (!(error instanceof ProductReservationNotActiveError)) throw error;
      }
    }
    return expired;
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ) {
    const [row] = await this.rows(
      manager,
      'WHERE r.tenant_id = ? AND r.idempotency_key = ?',
      [tenantId, key],
    );
    return row
      ? {
          reservation: await this.data(manager, row),
          fingerprint: row.request_fingerprint,
        }
      : null;
  }

  private async findById(manager: EntityManager, tenantId: string, id: string) {
    const [row] = await this.rows(
      manager,
      'WHERE r.tenant_id = ? AND r.id = ?',
      [tenantId, id],
    );
    return row ? this.data(manager, row) : null;
  }

  private rows(manager: EntityManager, where: string, parameters: unknown[]) {
    return manager.query<ReservationRow[]>(
      `SELECT r.id, r.tenant_id, r.reservation_number, r.status, r.request_fingerprint,
              r.expires_at, r.created_at, r.closed_at, r.closure_reason,
              s.id AS sale_id, s.receipt_number,
              c.id AS customer_id, c.name AS customer_name, c.identifier AS customer_identifier,
              b.id AS branch_id, b.name AS branch_name,
              w.id AS warehouse_id, w.name AS warehouse_name,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              u.id AS user_id, u.email AS user_email
       FROM product_reservations r
       INNER JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
       INNER JOIN branches b ON b.id = r.branch_id AND b.tenant_id = r.tenant_id
       INNER JOIN warehouses w ON w.id = r.warehouse_id AND w.tenant_id = r.tenant_id
       INNER JOIN locations l ON l.id = r.location_id AND l.tenant_id = r.tenant_id
       INNER JOIN users u ON u.id = r.created_by_user_id AND u.tenant_id = r.tenant_id
       LEFT JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
       ${where} ORDER BY r.created_at DESC, r.id DESC`,
      parameters,
    );
  }

  private async data(
    manager: EntityManager,
    row: ReservationRow,
  ): Promise<ProductReservationData> {
    const lines = await manager.query<
      Array<{
        id: string;
        product_id: string;
        product_name: string;
        product_sku: string;
        quantity: string;
        serial_numbers: string | string[] | null;
      }>
    >(
      `SELECT rl.id, rl.product_id, p.name AS product_name, p.sku AS product_sku,
              rl.quantity, rl.serial_numbers
       FROM product_reservation_lines rl
       INNER JOIN products p ON p.id = rl.product_id AND p.tenant_id = rl.tenant_id
       WHERE rl.reservation_id = ? AND rl.tenant_id = ? ORDER BY rl.line_number`,
      [row.id, row.tenant_id],
    );
    return {
      id: row.id,
      reservationNumber: row.reservation_number,
      status: row.status,
      customer: {
        id: row.customer_id,
        name: row.customer_name,
        identifier: row.customer_identifier,
      },
      context: {
        branch: { id: row.branch_id, name: row.branch_name },
        warehouse: { id: row.warehouse_id, name: row.warehouse_name },
        location: {
          id: row.location_id,
          name: row.location_name,
          code: row.location_code,
        },
      },
      responsible: { id: row.user_id, email: row.user_email },
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
      closureReason: row.closure_reason,
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
        quantity: this.decimal(this.units(line.quantity)),
        serialNumbers: this.serialNumbers(line.serial_numbers),
      })),
    };
  }

  private replay(
    stored: { reservation: ProductReservationData; fingerprint: string },
    fingerprint: string,
  ) {
    if (stored.fingerprint !== fingerprint)
      throw new ProductReservationIdempotencyConflictError();
    return { reservation: stored.reservation, replay: true };
  }

  private async close(
    manager: EntityManager,
    input: {
      tenantId: string;
      branchId: string;
      userId: string;
      reservationId: string;
      idempotencyKey: string;
      reason: string;
      status: 'RELEASED' | 'EXPIRED';
      fingerprint: string;
    },
  ): Promise<{ reservation: ProductReservationData; replay: boolean }> {
    const [reservation] = await manager.query<
      Array<{
        id: string;
        location_id: string;
        status: ReservationRow['status'];
        closed_idempotency_key: string | null;
        closed_request_fingerprint: string | null;
      }>
    >(
      `SELECT id, location_id, status, closed_idempotency_key,
              closed_request_fingerprint
       FROM product_reservations
       WHERE id = ? AND tenant_id = ? AND branch_id = ? LIMIT 1 FOR UPDATE`,
      [input.reservationId, input.tenantId, input.branchId],
    );
    if (!reservation) throw new ProductReservationTargetNotFoundError();
    if (reservation.status !== 'ACTIVE') {
      if (
        reservation.status === input.status &&
        reservation.closed_idempotency_key === input.idempotencyKey &&
        reservation.closed_request_fingerprint === input.fingerprint
      ) {
        const replay = await this.findById(
          manager,
          input.tenantId,
          reservation.id,
        );
        if (!replay) throw new Error('CLOSED_RESERVATION_NOT_FOUND');
        return { reservation: replay, replay: true };
      }
      throw new ProductReservationNotActiveError(reservation.status);
    }
    const lines = await manager.query<
      Array<{
        id: string;
        product_id: string;
        quantity: string;
        serial_numbers: string | string[] | null;
      }>
    >(
      `SELECT id, product_id, quantity, serial_numbers FROM product_reservation_lines
       WHERE reservation_id = ? AND tenant_id = ? ORDER BY product_id FOR UPDATE`,
      [reservation.id, input.tenantId],
    );
    for (const [index, line] of lines.entries()) {
      const [balance] = await manager.query<
        Array<{
          quantity: string;
          available_quantity: string;
          reserved_quantity: string;
        }>
      >(
        `SELECT quantity, available_quantity, reserved_quantity
         FROM inventory_balances
         WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
        [input.tenantId, line.product_id, reservation.location_id],
      );
      const quantity = this.units(line.quantity);
      if (!balance || this.units(balance.reserved_quantity) < quantity)
        throw new ProductReservationInsufficientStockError(line.product_id);
      const available = this.units(balance.available_quantity) + quantity;
      const reserved = this.units(balance.reserved_quantity) - quantity;
      const movementId = randomUUID();
      await manager.query(
        `UPDATE inventory_balances SET available_quantity = ?, reserved_quantity = ?
         WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
        [
          this.decimal(available),
          this.decimal(reserved),
          input.tenantId,
          line.product_id,
          reservation.location_id,
        ],
      );
      await manager.query(
        `INSERT INTO inventory_movements
          (id, tenant_id, product_id, location_id, type, from_state, to_state,
           state_quantity, quantity_change, resulting_quantity, reason, reference,
           idempotency_key, request_fingerprint, created_by_user_id,
           reservation_id, reservation_line_id)
         VALUES (?, ?, ?, ?, 'STATE_TRANSITION', 'RESERVED', 'AVAILABLE', ?, 0, ?,
                 ?, ?, ?, ?, ?, ?, ?)`,
        [
          movementId,
          input.tenantId,
          line.product_id,
          reservation.location_id,
          line.quantity,
          balance.quantity,
          input.reason,
          input.reservationId,
          `reservation-close:${input.reservationId}:${index + 1}`,
          input.fingerprint,
          input.userId,
          reservation.id,
          line.id,
        ],
      );
      await applyInventoryValuation(manager, movementId);
      await applyInventoryLotTracking(manager, movementId);
      await applyInventorySerialTracking(manager, movementId, {
        serialNumbers: this.serialNumbers(line.serial_numbers),
      });
    }
    await manager.query(
      `UPDATE product_reservations
       SET status = ?, closed_by_user_id = ?, closed_at = CURRENT_TIMESTAMP(6),
           closure_reason = ?, closed_idempotency_key = ?, closed_request_fingerprint = ?
       WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`,
      [
        input.status,
        input.userId,
        input.reason,
        input.idempotencyKey,
        input.fingerprint,
        reservation.id,
        input.tenantId,
      ],
    );
    const result = await this.findById(manager, input.tenantId, reservation.id);
    if (!result) throw new Error('CLOSED_RESERVATION_NOT_FOUND');
    return { reservation: result, replay: false };
  }

  private closeFingerprint(status: string, reason: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ status, reason }))
      .digest('hex');
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }

  private units(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  }

  private serialNumbers(value: string | string[] | null): string[] {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private decimal(units: bigint): string {
    return `${units / 1000n}.${String(units % 1000n).padStart(3, '0')}`;
  }
}

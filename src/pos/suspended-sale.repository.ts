import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  PosCustomerNotAvailableError,
  PosIdempotencyConflictError,
} from './pos.errors';
import type { PosCartQuoteResponse } from './pos.types';
import { SuspendedSaleStateError } from './suspended-sale.errors';
import type {
  SuspendedSaleData,
  SuspendedSaleStatus,
} from './suspended-sale.types';

interface SuspendedSaleRow {
  id: string;
  status: SuspendedSaleStatus;
  request_fingerprint: string;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  user_id: string;
  user_email: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_identifier: string | null;
  notes: string | null;
  completed_sale_id: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  cancelled_at: Date | string | null;
  resumed_at: Date | string | null;
}

@Injectable()
export class SuspendedSaleRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: {
    tenantId: string;
    userId: string;
    customerId: string | null;
    notes: string | null;
    idempotencyKey: string;
    fingerprint: string;
    quote: PosCartQuoteResponse['data'];
  }): Promise<{ sale: SuspendedSaleData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const replay = await this.findByIdempotency(
            manager,
            input.tenantId,
            input.idempotencyKey,
            input.userId,
          );
          if (replay) {
            if (replay.fingerprint !== input.fingerprint)
              throw new PosIdempotencyConflictError();
            return { sale: replay.sale, replay: true };
          }
          if (input.customerId) {
            const [customer] = await manager.query<Array<{ id: string }>>(
              `SELECT id FROM customers WHERE id = ? AND tenant_id = ? AND active = TRUE LIMIT 1`,
              [input.customerId, input.tenantId],
            );
            if (!customer) throw new PosCustomerNotAvailableError();
          }
          const id = randomUUID();
          await manager.query(
            `INSERT INTO suspended_sales
           (id, tenant_id, branch_id, warehouse_id, cash_register_id, created_by_user_id,
            customer_id, notes, status, idempotency_key, request_fingerprint, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 24 HOUR))`,
            [
              id,
              input.tenantId,
              input.quote.context.branch.id,
              input.quote.context.warehouse.id,
              input.quote.context.cashRegister.id,
              input.userId,
              input.customerId,
              input.notes,
              input.idempotencyKey,
              input.fingerprint,
            ],
          );
          for (const [index, line] of input.quote.lines.entries()) {
            await manager.query(
              `INSERT INTO suspended_sale_lines
             (id, tenant_id, suspended_sale_id, line_number, product_id, product_name,
              product_sku, quantity, lot_id, serial_numbers, unit_price_snapshot,
              available_quantity_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                id,
                index + 1,
                line.product.id,
                line.product.name,
                line.product.sku,
                line.quantity,
                line.lotId,
                JSON.stringify(line.serialNumbers),
                line.unitPrice,
                line.availableQuantity,
              ],
            );
          }
          const created = await this.findById(manager, input.tenantId, id);
          if (!created) throw new Error('SUSPENDED_SALE_NOT_CREATED');
          return { sale: created, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByIdempotency(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
        input.userId,
      );
      if (!replay || replay.fingerprint !== input.fingerprint)
        throw new PosIdempotencyConflictError();
      return { sale: replay.sale, replay: true };
    }
  }

  async list(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
  }): Promise<SuspendedSaleData[]> {
    await this.expire(input);
    const rows = await this.dataSource.query<SuspendedSaleRow[]>(
      `${this.baseSelect()}
       WHERE ss.tenant_id = ? AND ss.branch_id = ? AND ss.cash_register_id = ?
         AND ss.created_by_user_id = ?
       ORDER BY CASE ss.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, ss.created_at DESC LIMIT 50`,
      [input.tenantId, input.branchId, input.cashRegisterId, input.userId],
    );
    return Promise.all(
      rows.map((row) =>
        this.mapWithLines(this.dataSource.manager, input.tenantId, row),
      ),
    );
  }

  async findOwned(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    id: string;
  }): Promise<SuspendedSaleData | null> {
    await this.expire(input);
    const rows = await this.dataSource.query<SuspendedSaleRow[]>(
      `${this.baseSelect()}
       WHERE ss.id = ? AND ss.tenant_id = ? AND ss.branch_id = ? AND ss.warehouse_id = ?
         AND ss.cash_register_id = ? AND ss.created_by_user_id = ? LIMIT 1`,
      [
        input.id,
        input.tenantId,
        input.branchId,
        input.warehouseId,
        input.cashRegisterId,
        input.userId,
      ],
    );
    return rows[0]
      ? this.mapWithLines(this.dataSource.manager, input.tenantId, rows[0])
      : null;
  }

  async cancel(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    id: string;
  }): Promise<{ sale: SuspendedSaleData; replay: boolean } | null> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.expire(input, manager);
      const [row] = await manager.query<Array<{ status: SuspendedSaleStatus }>>(
        `SELECT status FROM suspended_sales
         WHERE id = ? AND tenant_id = ? AND branch_id = ? AND warehouse_id = ?
           AND cash_register_id = ? AND created_by_user_id = ? LIMIT 1 FOR UPDATE`,
        [
          input.id,
          input.tenantId,
          input.branchId,
          input.warehouseId,
          input.cashRegisterId,
          input.userId,
        ],
      );
      if (!row) return null;
      if (row.status === 'CANCELLED') {
        const sale = await this.findById(manager, input.tenantId, input.id);
        return sale ? { sale, replay: true } : null;
      }
      if (row.status !== 'ACTIVE')
        throw new SuspendedSaleStateError(row.status);
      await manager.query(
        `UPDATE suspended_sales SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND tenant_id = ?`,
        [input.id, input.tenantId],
      );
      const sale = await this.findById(manager, input.tenantId, input.id);
      if (!sale) throw new Error('SUSPENDED_SALE_NOT_FOUND_AFTER_CANCEL');
      return { sale, replay: false };
    });
  }

  private async expire(
    input: {
      tenantId: string;
      branchId: string;
      cashRegisterId: string;
      userId: string;
    },
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    await manager.query(
      `UPDATE suspended_sales SET status = 'EXPIRED'
       WHERE tenant_id = ? AND branch_id = ? AND cash_register_id = ?
         AND created_by_user_id = ? AND status = 'ACTIVE' AND expires_at <= CURRENT_TIMESTAMP(6)`,
      [input.tenantId, input.branchId, input.cashRegisterId, input.userId],
    );
  }

  private async findByIdempotency(
    manager: EntityManager,
    tenantId: string,
    key: string,
    userId: string,
  ) {
    const rows = await manager.query<SuspendedSaleRow[]>(
      `${this.baseSelect()}
       WHERE ss.tenant_id = ? AND ss.idempotency_key = ? AND ss.created_by_user_id = ? LIMIT 1`,
      [tenantId, key, userId],
    );
    if (!rows[0]) return null;
    return {
      fingerprint: rows[0].request_fingerprint,
      sale: await this.mapWithLines(manager, tenantId, rows[0]),
    };
  }

  private async findById(manager: EntityManager, tenantId: string, id: string) {
    const rows = await manager.query<SuspendedSaleRow[]>(
      `${this.baseSelect()} WHERE ss.tenant_id = ? AND ss.id = ? LIMIT 1`,
      [tenantId, id],
    );
    return rows[0] ? this.mapWithLines(manager, tenantId, rows[0]) : null;
  }

  private baseSelect(): string {
    return `SELECT ss.id, ss.status, ss.request_fingerprint, ss.notes,
                   ss.completed_sale_id, ss.expires_at, ss.created_at,
                   ss.cancelled_at, ss.resumed_at,
                   b.id AS branch_id, b.name AS branch_name,
                   w.id AS warehouse_id, w.name AS warehouse_name,
                   cr.id AS cash_register_id, cr.name AS cash_register_name,
                   cr.code AS cash_register_code,
                   u.id AS user_id, u.email AS user_email,
                   c.id AS customer_id, c.name AS customer_name,
                   c.identifier AS customer_identifier
            FROM suspended_sales ss
            INNER JOIN branches b ON b.id = ss.branch_id AND b.tenant_id = ss.tenant_id
            INNER JOIN warehouses w ON w.id = ss.warehouse_id AND w.tenant_id = ss.tenant_id
            INNER JOIN cash_registers cr ON cr.id = ss.cash_register_id AND cr.tenant_id = ss.tenant_id
            INNER JOIN users u ON u.id = ss.created_by_user_id AND u.tenant_id = ss.tenant_id
            LEFT JOIN customers c ON c.id = ss.customer_id AND c.tenant_id = ss.tenant_id`;
  }

  private async mapWithLines(
    manager: EntityManager,
    tenantId: string,
    row: SuspendedSaleRow,
  ): Promise<SuspendedSaleData> {
    const lines = await manager.query<
      Array<{
        product_id: string;
        product_name: string;
        product_sku: string;
        quantity: string;
        lot_id: string | null;
        serial_numbers: string | string[];
        unit_price_snapshot: string;
        available_quantity_snapshot: string;
      }>
    >(
      `SELECT product_id, product_name, product_sku, quantity, lot_id, serial_numbers,
              unit_price_snapshot, available_quantity_snapshot
       FROM suspended_sale_lines WHERE tenant_id = ? AND suspended_sale_id = ? ORDER BY line_number`,
      [tenantId, row.id],
    );
    return {
      id: row.id,
      status: row.status,
      context: {
        branch: { id: row.branch_id, name: row.branch_name },
        warehouse: { id: row.warehouse_id, name: row.warehouse_name },
        cashRegister: {
          id: row.cash_register_id,
          name: row.cash_register_name,
          code: row.cash_register_code,
        },
      },
      author: { id: row.user_id, email: row.user_email },
      customer: row.customer_id
        ? {
            id: row.customer_id,
            name: row.customer_name!,
            identifier: row.customer_identifier,
          }
        : null,
      notes: row.notes,
      lines: lines.map((line) => ({
        product: {
          id: line.product_id,
          name: line.product_name,
          sku: line.product_sku,
        },
        quantity: this.decimal(line.quantity, 3),
        lotId: line.lot_id,
        serialNumbers: this.serialNumbers(line.serial_numbers),
        unitPriceSnapshot: this.decimal(line.unit_price_snapshot, 2),
        availableQuantitySnapshot: this.decimal(
          line.available_quantity_snapshot,
          3,
        ),
      })),
      completedSaleId: row.completed_sale_id,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      cancelledAt: row.cancelled_at
        ? new Date(row.cancelled_at).toISOString()
        : null,
      resumedAt: row.resumed_at ? new Date(row.resumed_at).toISOString() : null,
    };
  }

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = String(value).split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }

  private serialNumbers(value: string | string[]): string[] {
    if (Array.isArray(value)) return value;
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      Number((error.driverError as { errno?: number }).errno) === 1062
    );
  }
}

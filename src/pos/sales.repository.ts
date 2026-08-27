import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  PosIdempotencyConflictError,
  PosInsufficientStockError,
  SaleAlreadyVoidedError,
  SaleVoidNotAllowedError,
} from './pos.errors';
import { ListSalesDto } from './dto/list-sales.dto';
import { CashRegisterShiftRequiredError } from './cash-register-shift.errors';
import {
  CashSaleData,
  PosCartQuoteResponse,
  SaleDetailData,
  SaleSummaryData,
} from './pos.types';
import { AuditService } from '../audit/audit.service';

interface SaleRow {
  id: string;
  receipt_number: string;
  status: 'COMPLETED' | 'VOIDED';
  created_by_user_id: string;
  currency: string;
  tax_rate: string;
  subtotal: string;
  tax_total: string;
  total: string;
  request_fingerprint: string;
  created_at: Date | string;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  amount_received: string;
  amount_applied: string;
  change_amount: string;
  payment_status: 'COMPLETED' | 'REVERSED';
  voided_by_user_id: string | null;
  voided_by_email: string | null;
  void_reason: string | null;
  voided_at: Date | string | null;
}

interface StockAllocation {
  locationId: string;
  quantityChange: string;
  resultingQuantity: string;
  resultingAvailableQuantity: string;
}

@Injectable()
export class SalesRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async listSales(
    tenantId: string,
    branchId: string,
    query: ListSalesDto,
  ): Promise<{ items: SaleSummaryData[]; total: number }> {
    const filters = ['s.tenant_id = ?', 's.branch_id = ?'];
    const parameters: unknown[] = [tenantId, branchId];
    if (query.dateFrom) {
      filters.push('s.created_at >= ?');
      parameters.push(`${query.dateFrom} 00:00:00`);
    }
    if (query.dateTo) {
      filters.push('s.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      parameters.push(`${query.dateTo} 00:00:00`);
    }
    if (query.cashRegisterId) {
      filters.push('s.cash_register_id = ?');
      parameters.push(query.cashRegisterId);
    }
    if (query.userId) {
      filters.push('s.created_by_user_id = ?');
      parameters.push(query.userId);
    }
    const where = filters.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<
        Array<{
          id: string;
          receipt_number: string;
          status: 'COMPLETED' | 'VOIDED';
          user_id: string;
          user_email: string;
          cash_register_id: string;
          cash_register_name: string;
          cash_register_code: string;
          currency: string;
          total: string;
          created_at: Date | string;
        }>
      >(
        `SELECT s.id, s.receipt_number, s.status,
                u.id AS user_id, u.email AS user_email,
                cr.id AS cash_register_id, cr.name AS cash_register_name,
                cr.code AS cash_register_code, s.currency, s.total, s.created_at
         FROM sales s
         INNER JOIN users u ON u.id = s.created_by_user_id AND u.tenant_id = s.tenant_id
         INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
         WHERE ${where}
         ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM sales s WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        receiptNumber: row.receipt_number,
        status: row.status,
        user: { id: row.user_id, email: row.user_email },
        cashRegister: {
          id: row.cash_register_id,
          name: row.cash_register_name,
          code: row.cash_register_code,
        },
        currency: row.currency,
        total: this.decimal(row.total, 2),
        paymentMethod: 'CASH',
        createdAt: new Date(row.created_at).toISOString(),
      })),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async getSaleDetail(
    tenantId: string,
    branchId: string,
    saleId: string,
  ): Promise<SaleDetailData | null> {
    const keys = await this.dataSource.query<
      Array<{ idempotency_key: string; user_email: string }>
    >(
      `SELECT s.idempotency_key, u.email AS user_email
       FROM sales s
       INNER JOIN users u ON u.id = s.created_by_user_id AND u.tenant_id = s.tenant_id
       WHERE s.id = ? AND s.tenant_id = ? AND s.branch_id = ? LIMIT 1`,
      [saleId, tenantId, branchId],
    );
    if (!keys[0]) return null;
    const found = await this.findWithManager(
      this.dataSource.manager,
      tenantId,
      keys[0].idempotency_key,
    );
    if (!found) return null;
    const movements = await this.dataSource.query<
      Array<{
        id: string;
        type: 'SALE' | 'SALE_VOID';
        sale_line_id: string;
        product_id: string;
        product_name: string;
        product_sku: string;
        location_id: string;
        location_name: string;
        location_code: string;
        quantity_change: string;
        resulting_quantity: string;
        reference: string;
        created_at: Date | string;
      }>
    >(
      `SELECT im.id, im.type, im.sale_line_id, p.id AS product_id,
              p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              im.quantity_change, im.resulting_quantity, im.reference, im.created_at
       FROM inventory_movements im
       INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
       INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
       WHERE im.tenant_id = ? AND im.sale_id = ? AND im.type IN ('SALE', 'SALE_VOID')
       ORDER BY im.created_at, im.id`,
      [tenantId, saleId],
    );
    const { userId, ...sale } = found.sale;
    return {
      ...sale,
      user: { id: userId, email: keys[0].user_email },
      movements: movements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        saleLineId: movement.sale_line_id,
        product: {
          id: movement.product_id,
          name: movement.product_name,
          sku: movement.product_sku,
        },
        location: {
          id: movement.location_id,
          name: movement.location_name,
          code: movement.location_code,
        },
        quantityChange: this.decimal(movement.quantity_change, 3),
        resultingQuantity: this.decimal(movement.resulting_quantity, 3),
        reference: movement.reference,
        createdAt: new Date(movement.created_at).toISOString(),
      })),
    };
  }

  async findByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ sale: CashSaleData; fingerprint: string } | null> {
    return this.findWithManager(
      this.dataSource.manager,
      tenantId,
      idempotencyKey,
    );
  }

  async voidSale(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    saleId: string;
    userId: string;
    reason: string;
    idempotencyKey: string;
    fingerprint: string;
    correlationId: string;
  }): Promise<{ saleId: string; replay: boolean } | null> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findVoidByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) {
            if (
              existing.saleId !== input.saleId ||
              existing.fingerprint !== input.fingerprint
            ) {
              throw new PosIdempotencyConflictError();
            }
            return { saleId: existing.saleId, replay: true };
          }

          const [sale] = await manager.query<
            Array<{
              id: string;
              receipt_number: string;
              status: 'COMPLETED' | 'VOIDED';
              cash_register_shift_id: string;
              void_idempotency_key: string | null;
              void_request_fingerprint: string | null;
            }>
          >(
            `SELECT id, receipt_number, status, cash_register_shift_id,
                    void_idempotency_key, void_request_fingerprint
             FROM sales
             WHERE id = ? AND tenant_id = ? AND branch_id = ? AND cash_register_id = ?
             LIMIT 1 FOR UPDATE`,
            [
              input.saleId,
              input.tenantId,
              input.branchId,
              input.cashRegisterId,
            ],
          );
          if (!sale) return null;
          if (sale.status === 'VOIDED') {
            if (
              sale.void_idempotency_key === input.idempotencyKey &&
              sale.void_request_fingerprint === input.fingerprint
            ) {
              return { saleId: sale.id, replay: true };
            }
            throw new SaleAlreadyVoidedError();
          }

          const [shift] = await manager.query<
            Array<{ status: 'OPEN' | 'CLOSED' }>
          >(
            `SELECT status FROM cash_register_shifts
             WHERE id = ? AND tenant_id = ? AND branch_id = ? AND cash_register_id = ?
             LIMIT 1 FOR UPDATE`,
            [
              sale.cash_register_shift_id,
              input.tenantId,
              input.branchId,
              input.cashRegisterId,
            ],
          );
          if (!shift || shift.status !== 'OPEN') {
            throw new SaleVoidNotAllowedError();
          }

          const movements = await manager.query<
            Array<{
              id: string;
              product_id: string;
              location_id: string;
              sale_line_id: string;
              quantity_change: string;
            }>
          >(
            `SELECT id, product_id, location_id, sale_line_id, quantity_change
             FROM inventory_movements
             WHERE tenant_id = ? AND sale_id = ? AND type = 'SALE'
             ORDER BY product_id, location_id, id FOR UPDATE`,
            [input.tenantId, sale.id],
          );
          for (const movement of movements) {
            const [balance] = await manager.query<
              Array<{ quantity: string; available_quantity: string }>
            >(
              `SELECT quantity, available_quantity FROM inventory_balances
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?
               LIMIT 1 FOR UPDATE`,
              [input.tenantId, movement.product_id, movement.location_id],
            );
            if (!balance) throw new Error('SALE_VOID_BALANCE_NOT_FOUND');
            const restored = -this.toQuantityUnits(movement.quantity_change);
            if (restored <= 0n) throw new Error('SALE_VOID_INVALID_MOVEMENT');
            const resultingQuantity =
              this.toQuantityUnits(balance.quantity) + restored;
            const resultingAvailable =
              this.toQuantityUnits(balance.available_quantity) + restored;
            await manager.query(
              `UPDATE inventory_balances
               SET quantity = ?, available_quantity = ?
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                this.fromQuantityUnits(resultingQuantity),
                this.fromQuantityUnits(resultingAvailable),
                input.tenantId,
                movement.product_id,
                movement.location_id,
              ],
            );
            const movementKey = `sale-void:${sale.id}:${movement.id}`;
            const movementFingerprint = createHash('sha256')
              .update(
                JSON.stringify({
                  saleId: sale.id,
                  originalMovementId: movement.id,
                  quantityChange: this.fromQuantityUnits(restored),
                }),
              )
              .digest('hex');
            await manager.query(
              `INSERT INTO inventory_movements
                (id, tenant_id, product_id, location_id, type, quantity_change,
                 resulting_quantity, reason, reference, idempotency_key,
                 request_fingerprint, created_by_user_id, sale_id, sale_line_id)
               VALUES (?, ?, ?, ?, 'SALE_VOID', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                movement.product_id,
                movement.location_id,
                this.fromQuantityUnits(restored),
                this.fromQuantityUnits(resultingQuantity),
                `Anulación ${sale.receipt_number}: ${input.reason}`,
                sale.receipt_number,
                movementKey,
                movementFingerprint,
                input.userId,
                sale.id,
                movement.sale_line_id,
              ],
            );
          }
          const paymentUpdate = await manager.query<{ affectedRows?: number }>(
            `UPDATE sale_payments
             SET status = 'REVERSED', reversed_by_user_id = ?, reversed_at = CURRENT_TIMESTAMP(6)
             WHERE tenant_id = ? AND sale_id = ? AND status = 'COMPLETED'`,
            [input.userId, input.tenantId, sale.id],
          );
          if (Number(paymentUpdate.affectedRows ?? 0) !== 1) {
            throw new Error('SALE_VOID_PAYMENT_NOT_REVERSED');
          }
          const saleUpdate = await manager.query<{ affectedRows?: number }>(
            `UPDATE sales SET status = 'VOIDED', voided_by_user_id = ?, void_reason = ?,
               void_idempotency_key = ?, void_request_fingerprint = ?,
               voided_at = CURRENT_TIMESTAMP(6)
             WHERE id = ? AND tenant_id = ? AND status = 'COMPLETED'`,
            [
              input.userId,
              input.reason,
              input.idempotencyKey,
              input.fingerprint,
              sale.id,
              input.tenantId,
            ],
          );
          if (Number(saleUpdate.affectedRows ?? 0) !== 1) {
            throw new Error('SALE_VOID_STATUS_NOT_UPDATED');
          }
          await this.audit.recordInTransaction(manager, {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: 'SALE_VOIDED',
            entityType: 'SALE',
            entityId: sale.id,
            correlationId: input.correlationId,
            deduplicate: true,
            before: { status: 'COMPLETED', paymentStatus: 'COMPLETED' },
            after: {
              status: 'VOIDED',
              paymentStatus: 'REVERSED',
              reason: input.reason,
              restoredMovementCount: movements.length,
            },
          });
          return { saleId: sale.id, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findVoidByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (
        !existing ||
        existing.saleId !== input.saleId ||
        existing.fingerprint !== input.fingerprint
      ) {
        throw new PosIdempotencyConflictError();
      }
      return { saleId: existing.saleId, replay: true };
    }
  }

  async persistCashSale(input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    fingerprint: string;
    cashRegisterShiftId: string;
    quote: PosCartQuoteResponse['data'];
    amountReceived: string;
    change: string;
  }): Promise<{ sale: CashSaleData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const replay = await this.findWithManager(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.fingerprint !== input.fingerprint)
              throw new PosIdempotencyConflictError();
            return { sale: replay.sale, replay: true };
          }
          const [openShift] = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM cash_register_shifts
             WHERE id = ? AND tenant_id = ? AND branch_id = ?
               AND cash_register_id = ? AND opened_by_user_id = ?
               AND status = 'OPEN' LIMIT 1 FOR UPDATE`,
            [
              input.cashRegisterShiftId,
              input.tenantId,
              input.quote.context.branch.id,
              input.quote.context.cashRegister.id,
              input.userId,
            ],
          );
          if (!openShift) throw new CashRegisterShiftRequiredError();
          const allocations = new Map<string, StockAllocation[]>();
          let insufficientProductId: string | null = null;
          for (const line of [...input.quote.lines].sort((left, right) =>
            left.product.id.localeCompare(right.product.id),
          )) {
            const balances = await manager.query<
              Array<{
                location_id: string;
                quantity: string;
                available_quantity: string;
              }>
            >(
              `SELECT ib.location_id, ib.quantity, ib.available_quantity
             FROM inventory_balances ib
             INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
             WHERE ib.tenant_id = ? AND ib.product_id = ? AND l.warehouse_id = ?
             ORDER BY l.created_at, l.id FOR UPDATE`,
              [
                input.tenantId,
                line.product.id,
                input.quote.context.warehouse.id,
              ],
            );
            let remaining = this.toQuantityUnits(line.quantity);
            const lineAllocations: StockAllocation[] = [];
            for (const balance of balances) {
              if (remaining === 0n) break;
              const available = this.toQuantityUnits(
                balance.available_quantity,
              );
              const total = this.toQuantityUnits(balance.quantity);
              const taken = available < remaining ? available : remaining;
              if (taken === 0n) continue;
              lineAllocations.push({
                locationId: balance.location_id,
                quantityChange: this.fromQuantityUnits(-taken),
                resultingQuantity: this.fromQuantityUnits(total - taken),
                resultingAvailableQuantity: this.fromQuantityUnits(
                  available - taken,
                ),
              });
              remaining -= taken;
            }
            allocations.set(line.product.id, lineAllocations);
            if (remaining > 0n) insufficientProductId = line.product.id;
          }
          const replayAfterLock = await this.findWithManager(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replayAfterLock) {
            if (replayAfterLock.fingerprint !== input.fingerprint)
              throw new PosIdempotencyConflictError();
            return { sale: replayAfterLock.sale, replay: true };
          }
          if (insufficientProductId) {
            throw new PosInsufficientStockError(insufficientProductId);
          }
          const saleId = randomUUID();
          const receiptNumber = `V-${saleId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
          await manager.query(
            `INSERT INTO sales
            (id, tenant_id, branch_id, warehouse_id, cash_register_id,
             cash_register_shift_id, created_by_user_id, receipt_number, currency, tax_rate, subtotal,
             tax_total, total, status, idempotency_key, request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)`,
            [
              saleId,
              input.tenantId,
              input.quote.context.branch.id,
              input.quote.context.warehouse.id,
              input.quote.context.cashRegister.id,
              input.cashRegisterShiftId,
              input.userId,
              receiptNumber,
              input.quote.currency,
              input.quote.taxRate,
              input.quote.totals.subtotal,
              input.quote.totals.tax,
              input.quote.totals.total,
              input.idempotencyKey,
              input.fingerprint,
            ],
          );
          for (const [index, line] of input.quote.lines.entries()) {
            const saleLineId = randomUUID();
            await manager.query(
              `INSERT INTO sale_lines
              (id, tenant_id, sale_id, line_number, product_id, product_name,
               product_sku, quantity, unit_price, subtotal, tax, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                saleLineId,
                input.tenantId,
                saleId,
                index + 1,
                line.product.id,
                line.product.name,
                line.product.sku,
                line.quantity,
                line.unitPrice,
                line.subtotal,
                line.tax,
                line.total,
              ],
            );
            for (const [allocationIndex, allocation] of (
              allocations.get(line.product.id) ?? []
            ).entries()) {
              await manager.query(
                `UPDATE inventory_balances
                 SET quantity = ?, available_quantity = ?
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
                [
                  allocation.resultingQuantity,
                  allocation.resultingAvailableQuantity,
                  input.tenantId,
                  line.product.id,
                  allocation.locationId,
                ],
              );
              const movementKey = `sale:${saleId}:${index + 1}:${allocationIndex + 1}`;
              const movementFingerprint = createHash('sha256')
                .update(
                  JSON.stringify({
                    saleId,
                    saleLineId,
                    productId: line.product.id,
                    locationId: allocation.locationId,
                    quantityChange: allocation.quantityChange,
                  }),
                )
                .digest('hex');
              await manager.query(
                `INSERT INTO inventory_movements
                (id, tenant_id, product_id, location_id, type, quantity_change,
                 resulting_quantity, reason, reference, idempotency_key,
                 request_fingerprint, created_by_user_id, sale_id, sale_line_id)
               VALUES (?, ?, ?, ?, 'SALE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  randomUUID(),
                  input.tenantId,
                  line.product.id,
                  allocation.locationId,
                  allocation.quantityChange,
                  allocation.resultingQuantity,
                  `Venta ${receiptNumber}`,
                  receiptNumber,
                  movementKey,
                  movementFingerprint,
                  input.userId,
                  saleId,
                  saleLineId,
                ],
              );
            }
          }
          await manager.query(
            `INSERT INTO sale_payments
            (id, tenant_id, sale_id, method, currency, amount_received,
             amount_applied, change_amount)
           VALUES (?, ?, ?, 'CASH', ?, ?, ?, ?)`,
            [
              randomUUID(),
              input.tenantId,
              saleId,
              input.quote.currency,
              input.amountReceived,
              input.quote.totals.total,
              input.change,
            ],
          );
          const created = await this.findWithManager(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (!created) throw new Error('CREATED_CASH_SALE_NOT_FOUND');
          return { sale: created.sale, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByIdempotency(
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay || replay.fingerprint !== input.fingerprint)
        throw new PosIdempotencyConflictError();
      return { sale: replay.sale, replay: true };
    }
  }

  private async findWithManager(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ sale: CashSaleData; fingerprint: string } | null> {
    const rows = await manager.query<SaleRow[]>(
      `SELECT s.id, s.receipt_number, s.status, s.created_by_user_id,
              s.currency, s.tax_rate, s.subtotal, s.tax_total, s.total,
              s.request_fingerprint, s.created_at, s.voided_by_user_id,
              vu.email AS voided_by_email, s.void_reason, s.voided_at,
              b.id AS branch_id, b.name AS branch_name,
              w.id AS warehouse_id, w.name AS warehouse_name,
              cr.id AS cash_register_id, cr.name AS cash_register_name,
              cr.code AS cash_register_code,
              sp.amount_received, sp.amount_applied, sp.change_amount,
              sp.status AS payment_status
       FROM sales s
       INNER JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
       INNER JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = s.tenant_id
       INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
       INNER JOIN sale_payments sp ON sp.sale_id = s.id AND sp.tenant_id = s.tenant_id AND sp.method = 'CASH'
       LEFT JOIN users vu ON vu.id = s.voided_by_user_id AND vu.tenant_id = s.tenant_id
       WHERE s.tenant_id = ? AND s.idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const lines = await manager.query<
      Array<{
        product_id: string;
        product_name: string;
        product_sku: string;
        quantity: string;
        unit_price: string;
        subtotal: string;
        tax: string;
        total: string;
      }>
    >(
      `SELECT product_id, product_name, product_sku, quantity, unit_price,
              subtotal, tax, total
       FROM sale_lines WHERE tenant_id = ? AND sale_id = ? ORDER BY line_number`,
      [tenantId, row.id],
    );
    return {
      fingerprint: row.request_fingerprint,
      sale: {
        id: row.id,
        receiptNumber: row.receipt_number,
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
        userId: row.created_by_user_id,
        currency: row.currency,
        taxRate: this.decimal(row.tax_rate, 4),
        lines: lines.map((line) => ({
          product: {
            id: line.product_id,
            name: line.product_name,
            sku: line.product_sku,
          },
          quantity: this.decimal(line.quantity, 3),
          unitPrice: this.decimal(line.unit_price, 2),
          subtotal: this.decimal(line.subtotal, 2),
          tax: this.decimal(line.tax, 2),
          total: this.decimal(line.total, 2),
        })),
        totals: {
          subtotal: this.decimal(row.subtotal, 2),
          tax: this.decimal(row.tax_total, 2),
          total: this.decimal(row.total, 2),
        },
        payment: {
          method: 'CASH',
          status: row.payment_status,
          amountReceived: this.decimal(row.amount_received, 2),
          amountApplied: this.decimal(row.amount_applied, 2),
          change: this.decimal(row.change_amount, 2),
        },
        createdAt: new Date(row.created_at).toISOString(),
        void:
          row.voided_by_user_id &&
          row.voided_by_email &&
          row.void_reason &&
          row.voided_at
            ? {
                reason: row.void_reason,
                user: { id: row.voided_by_user_id, email: row.voided_by_email },
                voidedAt: new Date(row.voided_at).toISOString(),
              }
            : null,
      },
    };
  }

  private async findVoidByKey(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ saleId: string; fingerprint: string } | null> {
    const [row] = await manager.query<
      Array<{ id: string; void_request_fingerprint: string }>
    >(
      `SELECT id, void_request_fingerprint FROM sales
       WHERE tenant_id = ? AND void_idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return row
      ? { saleId: row.id, fingerprint: row.void_request_fingerprint }
      : null;
  }

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }

  private toQuantityUnits(value: string): bigint {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const units = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
    return negative ? -units : units;
  }

  private fromQuantityUnits(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}

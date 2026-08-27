import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { PosIdempotencyConflictError } from './pos.errors';
import { CashSaleData, PosCartQuoteResponse } from './pos.types';

interface SaleRow {
  id: string;
  receipt_number: string;
  status: 'COMPLETED';
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
}

@Injectable()
export class SalesRepository {
  constructor(private readonly dataSource: DataSource) {}

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

  async persistCashSale(input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    fingerprint: string;
    quote: PosCartQuoteResponse['data'];
    amountReceived: string;
    change: string;
  }): Promise<{ sale: CashSaleData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
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
        const saleId = randomUUID();
        const receiptNumber = `V-${saleId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
        await manager.query(
          `INSERT INTO sales
            (id, tenant_id, branch_id, warehouse_id, cash_register_id,
             created_by_user_id, receipt_number, currency, tax_rate, subtotal,
             tax_total, total, status, idempotency_key, request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)`,
          [
            saleId,
            input.tenantId,
            input.quote.context.branch.id,
            input.quote.context.warehouse.id,
            input.quote.context.cashRegister.id,
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
          await manager.query(
            `INSERT INTO sale_lines
              (id, tenant_id, sale_id, line_number, product_id, product_name,
               product_sku, quantity, unit_price, subtotal, tax, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
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
      });
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
              s.request_fingerprint, s.created_at,
              b.id AS branch_id, b.name AS branch_name,
              w.id AS warehouse_id, w.name AS warehouse_name,
              cr.id AS cash_register_id, cr.name AS cash_register_name,
              cr.code AS cash_register_code,
              sp.amount_received, sp.amount_applied, sp.change_amount
       FROM sales s
       INNER JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
       INNER JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = s.tenant_id
       INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
       INNER JOIN sale_payments sp ON sp.sale_id = s.id AND sp.tenant_id = s.tenant_id AND sp.method = 'CASH'
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
          amountReceived: this.decimal(row.amount_received, 2),
          amountApplied: this.decimal(row.amount_applied, 2),
          change: this.decimal(row.change_amount, 2),
        },
        createdAt: new Date(row.created_at).toISOString(),
      },
    };
  }

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { PosCartQuoteResponse } from '../pos/pos.types';
import {
  SalesQuotationIdempotencyConflictError,
  SalesQuotationNotFoundError,
  SalesQuotationReservationConflictError,
  SalesQuotationStateError,
  SalesQuotationVersionConflictError,
} from './sales-quotation.errors';
import type {
  SalesQuotationData,
  SalesQuotationStatus,
} from './sales-quotation.types';
import type { ListSalesQuotationsDto } from './dto/list-sales-quotations.dto';

interface QuotationRow {
  id: string;
  quotation_number: string;
  status: SalesQuotationStatus;
  version: number | string;
  channel: SalesQuotationData['channel'];
  customer_id: string | null;
  customer_name: string | null;
  customer_identifier: string | null;
  reservation_id: string | null;
  reservation_number: string | null;
  reservation_status: string | null;
  sale_id: string | null;
  receipt_number: string | null;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  currency: string;
  tax_rate: string;
  gross_total: string;
  line_discount_total: string;
  sale_discount_total: string;
  discount_total: string;
  discount_type: 'PERCENT' | 'AMOUNT' | null;
  discount_value: string | null;
  discount_reason: string | null;
  subtotal: string;
  tax_total: string;
  total: string;
  valid_until: Date | string;
  notes: string | null;
  request_fingerprint: string;
  created_at: Date | string;
  updated_at: Date | string;
  converted_at: Date | string | null;
}

interface QuotationLineRow {
  product_id: string;
  product_name: string;
  product_sku: string;
  quantity: string;
  lot_id: string | null;
  serial_numbers: string | string[];
  available_quantity: string;
  unit_price: string;
  price_source: 'BASE' | 'PRICE_LIST';
  price_list_id: string | null;
  price_list_name: string | null;
  gross_total: string;
  line_discount_total: string;
  sale_discount_total: string;
  discount_total: string;
  discount_type: 'PERCENT' | 'AMOUNT' | null;
  discount_value: string | null;
  discount_reason: string | null;
  subtotal: string;
  tax: string;
  total: string;
}

@Injectable()
export class SalesQuotationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    customerId: string | null;
    reservationId: string | null;
    channel: SalesQuotationData['channel'];
    validUntil: string;
    notes: string | null;
    idempotencyKey: string;
    fingerprint: string;
    quote: PosCartQuoteResponse['data'];
  }): Promise<{ quotation: SalesQuotationData; replay: boolean }> {
    const existing = await this.findCreateReplay(
      input.tenantId,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.fingerprint !== input.fingerprint)
        throw new SalesQuotationIdempotencyConflictError();
      return { quotation: existing.quotation, replay: true };
    }
    const id = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO sales_quotations
           (id, tenant_id, branch_id, warehouse_id, cash_register_id, customer_id,
            reservation_id, quotation_number, channel, status, currency, tax_rate,
            gross_total, line_discount_total, sale_discount_total, discount_total,
            discount_type, discount_value, discount_reason, subtotal, tax_total, total,
            valid_until, notes, idempotency_key, request_fingerprint, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.tenantId,
            input.branchId,
            input.warehouseId,
            input.cashRegisterId,
            input.customerId,
            input.reservationId,
            this.number(id),
            input.channel,
            input.quote.currency,
            input.quote.taxRate,
            input.quote.totals.gross,
            input.quote.totals.lineDiscount,
            input.quote.totals.saleDiscount,
            input.quote.totals.discount,
            input.quote.discount?.type ?? null,
            input.quote.discount?.value ?? null,
            input.quote.discount?.reason ?? null,
            input.quote.totals.subtotal,
            input.quote.totals.tax,
            input.quote.totals.total,
            new Date(input.validUntil),
            input.notes,
            input.idempotencyKey,
            input.fingerprint,
            input.userId,
          ],
        );
        await this.replaceLines(manager, input.tenantId, id, input.quote);
      });
    } catch (error) {
      if (!this.duplicate(error)) throw error;
      if (this.constraint(error, 'uq_sales_quotations_reservation'))
        throw new SalesQuotationReservationConflictError();
      const replay = await this.findCreateReplay(
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay || replay.fingerprint !== input.fingerprint)
        throw new SalesQuotationIdempotencyConflictError();
      return { quotation: replay.quotation, replay: true };
    }
    const quotation = await this.find(input.tenantId, input.branchId, id);
    if (!quotation) throw new SalesQuotationNotFoundError();
    return { quotation, replay: false };
  }

  async update(input: {
    tenantId: string;
    branchId: string;
    quotationId: string;
    version: number;
    customerId: string | null;
    reservationId: string | null;
    channel: SalesQuotationData['channel'];
    validUntil: string;
    notes: string | null;
    idempotencyKey: string;
    fingerprint: string;
    quote: PosCartQuoteResponse['data'];
  }): Promise<{ quotation: SalesQuotationData; replay: boolean }> {
    const replay = await this.findOperation(
      input.tenantId,
      input.idempotencyKey,
    );
    if (replay) return this.operationReplay(input, replay);
    try {
      await this.dataSource.transaction(async (manager) => {
        const repeated = await this.findOperation(
          input.tenantId,
          input.idempotencyKey,
          manager,
        );
        if (repeated) {
          if (
            repeated.quotationId !== input.quotationId ||
            repeated.fingerprint !== input.fingerprint
          )
            throw new SalesQuotationIdempotencyConflictError();
          return;
        }
        const current = await this.lock(
          manager,
          input.tenantId,
          input.branchId,
          input.quotationId,
        );
        this.assertEditable(current, input.version);
        await manager.query(
          `UPDATE sales_quotations SET customer_id = ?, reservation_id = ?, channel = ?,
             currency = ?, tax_rate = ?, gross_total = ?, line_discount_total = ?,
             sale_discount_total = ?, discount_total = ?, discount_type = ?, discount_value = ?,
             discount_reason = ?, subtotal = ?, tax_total = ?, total = ?, valid_until = ?, notes = ?,
             version = version + 1 WHERE id = ? AND tenant_id = ?`,
          [
            input.customerId,
            input.reservationId,
            input.channel,
            input.quote.currency,
            input.quote.taxRate,
            input.quote.totals.gross,
            input.quote.totals.lineDiscount,
            input.quote.totals.saleDiscount,
            input.quote.totals.discount,
            input.quote.discount?.type ?? null,
            input.quote.discount?.value ?? null,
            input.quote.discount?.reason ?? null,
            input.quote.totals.subtotal,
            input.quote.totals.tax,
            input.quote.totals.total,
            new Date(input.validUntil),
            input.notes,
            input.quotationId,
            input.tenantId,
          ],
        );
        await this.replaceLines(
          manager,
          input.tenantId,
          input.quotationId,
          input.quote,
        );
        await this.insertOperation(manager, input, 'UPDATE');
      });
    } catch (error) {
      if (!this.duplicate(error)) throw error;
      if (this.constraint(error, 'uq_sales_quotations_reservation'))
        throw new SalesQuotationReservationConflictError();
      const repeated = await this.findOperation(
        input.tenantId,
        input.idempotencyKey,
      );
      if (!repeated) throw error;
      return this.operationReplay(input, repeated);
    }
    const quotation = await this.find(
      input.tenantId,
      input.branchId,
      input.quotationId,
    );
    if (!quotation) throw new SalesQuotationNotFoundError();
    return { quotation, replay: false };
  }

  async beginConversion(input: {
    tenantId: string;
    branchId: string;
    quotationId: string;
    version: number;
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<{ quotation: SalesQuotationData; replay: boolean }> {
    const replay = await this.findOperation(
      input.tenantId,
      input.idempotencyKey,
    );
    if (replay) return this.operationReplay(input, replay);
    try {
      await this.dataSource.transaction(async (manager) => {
        const current = await this.lock(
          manager,
          input.tenantId,
          input.branchId,
          input.quotationId,
        );
        if (current.status === 'CONVERTED' || current.status === 'CONVERTING')
          return;
        this.assertEditable(current, input.version);
        await manager.query(
          `UPDATE sales_quotations SET status = 'CONVERTING' WHERE id = ? AND tenant_id = ?`,
          [input.quotationId, input.tenantId],
        );
        await this.insertOperation(manager, input, 'CONVERT');
      });
    } catch (error) {
      if (!this.duplicate(error)) throw error;
      const repeated = await this.findOperation(
        input.tenantId,
        input.idempotencyKey,
      );
      if (!repeated) throw error;
      return this.operationReplay(input, repeated);
    }
    const quotation = await this.find(
      input.tenantId,
      input.branchId,
      input.quotationId,
    );
    if (!quotation) throw new SalesQuotationNotFoundError();
    return { quotation, replay: quotation.status !== 'CONVERTING' };
  }

  async completeConversion(
    tenantId: string,
    branchId: string,
    quotationId: string,
  ) {
    await this.dataSource.query(
      `UPDATE sales_quotations SET status = 'CONVERTED', converted_at = CURRENT_TIMESTAMP(6),
         version = version + 1 WHERE id = ? AND tenant_id = ? AND branch_id = ? AND status = 'CONVERTING'`,
      [quotationId, tenantId, branchId],
    );
    const quotation = await this.find(tenantId, branchId, quotationId);
    if (!quotation) throw new SalesQuotationNotFoundError();
    return quotation;
  }

  async abortConversion(
    tenantId: string,
    branchId: string,
    quotationId: string,
    idempotencyKey: string,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const [sale] = await manager.query<Array<{ id: string }>>(
        'SELECT id FROM sales WHERE tenant_id = ? AND quotation_id = ? LIMIT 1',
        [tenantId, quotationId],
      );
      if (sale) return;
      await manager.query(
        "UPDATE sales_quotations SET status = 'ACTIVE' WHERE id = ? AND tenant_id = ? AND branch_id = ? AND status = 'CONVERTING'",
        [quotationId, tenantId, branchId],
      );
      await manager.query(
        "DELETE FROM sales_quotation_operations WHERE tenant_id = ? AND quotation_id = ? AND idempotency_key = ? AND action = 'CONVERT'",
        [tenantId, quotationId, idempotencyKey],
      );
    });
  }

  async list(
    tenantId: string,
    branchId: string,
    query: ListSalesQuotationsDto,
  ) {
    await this.expire(tenantId, branchId);
    const filters = ['tenant_id = ?', 'branch_id = ?'];
    const params: unknown[] = [tenantId, branchId];
    if (query.status) {
      filters.push('status = ?');
      params.push(query.status);
    }
    const where = filters.join(' AND ');
    const [ids, total] = await Promise.all([
      this.dataSource.query<Array<{ id: string }>>(
        `SELECT id FROM sales_quotations WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM sales_quotations WHERE ${where}`,
        params,
      ),
    ]);
    const quotations = (
      await Promise.all(ids.map(({ id }) => this.find(tenantId, branchId, id)))
    ).filter((value): value is SalesQuotationData => Boolean(value));
    return { quotations, total: Number(total[0]?.total ?? 0) };
  }

  async find(
    tenantId: string,
    branchId: string,
    quotationId: string,
  ): Promise<SalesQuotationData | null> {
    await this.expire(tenantId, branchId, quotationId);
    return this.findWithManager(
      this.dataSource.manager,
      tenantId,
      branchId,
      quotationId,
    );
  }

  private async findWithManager(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    id: string,
  ) {
    const [row] = await manager.query<QuotationRow[]>(
      `SELECT q.*, b.name AS branch_name, w.name AS warehouse_name,
              cr.name AS cash_register_name, cr.code AS cash_register_code,
              c.name AS customer_name, c.identifier AS customer_identifier,
              r.reservation_number, r.status AS reservation_status,
              s.id AS sale_id, s.receipt_number
       FROM sales_quotations q
       INNER JOIN branches b ON b.id = q.branch_id AND b.tenant_id = q.tenant_id
       INNER JOIN warehouses w ON w.id = q.warehouse_id AND w.tenant_id = q.tenant_id
       INNER JOIN cash_registers cr ON cr.id = q.cash_register_id AND cr.tenant_id = q.tenant_id
       LEFT JOIN customers c ON c.id = q.customer_id AND c.tenant_id = q.tenant_id
       LEFT JOIN product_reservations r ON r.id = q.reservation_id AND r.tenant_id = q.tenant_id
       LEFT JOIN sales s ON s.quotation_id = q.id AND s.tenant_id = q.tenant_id
       WHERE q.id = ? AND q.tenant_id = ? AND q.branch_id = ? LIMIT 1`,
      [id, tenantId, branchId],
    );
    if (!row) return null;
    const lines = await manager.query<QuotationLineRow[]>(
      `SELECT * FROM sales_quotation_lines WHERE tenant_id = ? AND quotation_id = ? ORDER BY line_number`,
      [tenantId, id],
    );
    return this.map(row, lines);
  }

  private map(
    row: QuotationRow,
    lines: QuotationLineRow[],
  ): SalesQuotationData {
    return {
      id: row.id,
      quotationNumber: row.quotation_number,
      status: row.status,
      version: Number(row.version),
      channel: row.channel,
      customer: row.customer_id
        ? {
            id: row.customer_id,
            name: row.customer_name!,
            identifier: row.customer_identifier,
          }
        : null,
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
      context: {
        branch: { id: row.branch_id, name: row.branch_name },
        warehouse: { id: row.warehouse_id, name: row.warehouse_name },
        cashRegister: {
          id: row.cash_register_id,
          name: row.cash_register_name,
          code: row.cash_register_code,
        },
      },
      currency: row.currency,
      taxRate: this.decimal(row.tax_rate, 4),
      discount: row.discount_type
        ? {
            type: row.discount_type,
            value: this.decimal(row.discount_value!, 2),
            reason: row.discount_reason!,
            amount: this.decimal(row.sale_discount_total, 2),
          }
        : null,
      lines: lines.map((line) => ({
        product: {
          id: line.product_id,
          name: line.product_name,
          sku: line.product_sku,
        },
        quantity: this.decimal(line.quantity, 3),
        lotId: line.lot_id,
        serialNumbers: this.json(line.serial_numbers),
        availableQuantity: this.decimal(line.available_quantity, 3),
        unitPrice: this.decimal(line.unit_price, 2),
        priceSource: line.price_source,
        priceList: line.price_list_id
          ? { id: line.price_list_id, name: line.price_list_name! }
          : null,
        grossTotal: this.decimal(line.gross_total, 2),
        discount: {
          line: line.discount_type
            ? {
                type: line.discount_type,
                value: this.decimal(line.discount_value!, 2),
                reason: line.discount_reason!,
                amount: this.decimal(line.line_discount_total, 2),
              }
            : null,
          sale: row.discount_type
            ? {
                type: row.discount_type,
                value: this.decimal(row.discount_value!, 2),
                reason: row.discount_reason!,
                amount: this.decimal(line.sale_discount_total, 2),
              }
            : null,
          total: this.decimal(line.discount_total, 2),
        },
        subtotal: this.decimal(line.subtotal, 2),
        tax: this.decimal(line.tax, 2),
        total: this.decimal(line.total, 2),
      })),
      totals: {
        gross: this.decimal(row.gross_total, 2),
        lineDiscount: this.decimal(row.line_discount_total, 2),
        saleDiscount: this.decimal(row.sale_discount_total, 2),
        discount: this.decimal(row.discount_total, 2),
        subtotal: this.decimal(row.subtotal, 2),
        tax: this.decimal(row.tax_total, 2),
        total: this.decimal(row.total, 2),
      },
      validUntil: new Date(row.valid_until).toISOString(),
      notes: row.notes,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      convertedAt: row.converted_at
        ? new Date(row.converted_at).toISOString()
        : null,
    };
  }

  private async replaceLines(
    manager: EntityManager,
    tenantId: string,
    id: string,
    quote: PosCartQuoteResponse['data'],
  ) {
    await manager.query(
      'DELETE FROM sales_quotation_lines WHERE tenant_id = ? AND quotation_id = ?',
      [tenantId, id],
    );
    for (const [index, line] of quote.lines.entries()) {
      await manager.query(
        `INSERT INTO sales_quotation_lines
         (id, tenant_id, quotation_id, line_number, product_id, lot_id, quantity, serial_numbers,
          product_name, product_sku, available_quantity, unit_price, price_source, price_list_id,
          price_list_name, gross_total, line_discount_total, sale_discount_total, discount_total,
          discount_type, discount_value, discount_reason, subtotal, tax, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          tenantId,
          id,
          index + 1,
          line.product.id,
          line.lotId,
          line.quantity,
          JSON.stringify(line.serialNumbers),
          line.product.name,
          line.product.sku,
          line.availableQuantity,
          line.unitPrice,
          line.priceSource,
          line.priceList?.id ?? null,
          line.priceList?.name ?? null,
          line.grossTotal,
          line.discount.line?.amount ?? '0.00',
          line.discount.sale?.amount ?? '0.00',
          line.discount.total,
          line.discount.line?.type ?? null,
          line.discount.line?.value ?? null,
          line.discount.line?.reason ?? null,
          line.subtotal,
          line.tax,
          line.total,
        ],
      );
    }
  }

  private async findCreateReplay(tenantId: string, key: string) {
    const [row] = await this.dataSource.query<
      Array<{ id: string; branch_id: string; request_fingerprint: string }>
    >(
      'SELECT id, branch_id, request_fingerprint FROM sales_quotations WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1',
      [tenantId, key],
    );
    if (!row) return null;
    const quotation = await this.find(tenantId, row.branch_id, row.id);
    return quotation
      ? { quotation, fingerprint: row.request_fingerprint }
      : null;
  }

  private async findOperation(
    tenantId: string,
    key: string,
    manager = this.dataSource.manager,
  ) {
    const [row] = await manager.query<
      Array<{
        quotation_id: string;
        action: string;
        request_fingerprint: string;
      }>
    >(
      'SELECT quotation_id, action, request_fingerprint FROM sales_quotation_operations WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1',
      [tenantId, key],
    );
    return row
      ? {
          quotationId: row.quotation_id,
          action: row.action,
          fingerprint: row.request_fingerprint,
        }
      : null;
  }

  private async operationReplay(
    input: {
      tenantId: string;
      branchId: string;
      quotationId: string;
      fingerprint: string;
    },
    operation: { quotationId: string; fingerprint: string },
  ) {
    if (
      operation.quotationId !== input.quotationId ||
      operation.fingerprint !== input.fingerprint
    )
      throw new SalesQuotationIdempotencyConflictError();
    const quotation = await this.find(
      input.tenantId,
      input.branchId,
      input.quotationId,
    );
    if (!quotation) throw new SalesQuotationNotFoundError();
    return { quotation, replay: true };
  }

  private async lock(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    id: string,
  ) {
    const [row] = await manager.query<
      Array<{
        status: SalesQuotationStatus;
        version: number | string;
        expired: number | boolean;
      }>
    >(
      `SELECT status, version, valid_until <= CURRENT_TIMESTAMP(6) AS expired
       FROM sales_quotations WHERE id = ? AND tenant_id = ? AND branch_id = ? LIMIT 1 FOR UPDATE`,
      [id, tenantId, branchId],
    );
    if (!row) throw new SalesQuotationNotFoundError();
    if (row.status === 'ACTIVE' && Number(row.expired) === 1) {
      await manager.query(
        "UPDATE sales_quotations SET status = 'EXPIRED' WHERE id = ? AND tenant_id = ?",
        [id, tenantId],
      );
      row.status = 'EXPIRED';
    }
    return row;
  }

  private assertEditable(
    row: { status: SalesQuotationStatus; version: number | string },
    version: number,
  ) {
    if (row.status !== 'ACTIVE') throw new SalesQuotationStateError(row.status);
    if (Number(row.version) !== version)
      throw new SalesQuotationVersionConflictError();
  }

  private insertOperation(
    manager: EntityManager,
    input: {
      tenantId: string;
      quotationId: string;
      idempotencyKey: string;
      fingerprint: string;
    },
    action: 'UPDATE' | 'CONVERT',
  ) {
    return manager.query(
      `INSERT INTO sales_quotation_operations (id, tenant_id, quotation_id, action, idempotency_key, request_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.tenantId,
        input.quotationId,
        action,
        input.idempotencyKey,
        input.fingerprint,
      ],
    );
  }

  private expire(tenantId: string, branchId: string, id?: string) {
    return this.dataSource.query(
      `UPDATE sales_quotations SET status = 'EXPIRED'
       WHERE tenant_id = ? AND branch_id = ? AND status = 'ACTIVE'
         AND valid_until <= CURRENT_TIMESTAMP(6)${id ? ' AND id = ?' : ''}`,
      id ? [tenantId, branchId, id] : [tenantId, branchId],
    );
  }

  private number(id: string) {
    return `COT-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  }
  private decimal(value: string, scale: number) {
    const [whole, fraction = ''] = String(value).split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }
  private json(value: string | string[]) {
    return Array.isArray(value)
      ? value
      : (JSON.parse(value || '[]') as string[]);
  }
  private duplicate(error: unknown) {
    return (
      error instanceof QueryFailedError &&
      (error as QueryFailedError & { driverError?: { code?: string } })
        .driverError?.code === 'ER_DUP_ENTRY'
    );
  }
  private constraint(error: unknown, name: string) {
    return (
      error instanceof QueryFailedError &&
      String(
        (error as QueryFailedError & { driverError?: { sqlMessage?: string } })
          .driverError?.sqlMessage ?? '',
      ).includes(name)
    );
  }
}

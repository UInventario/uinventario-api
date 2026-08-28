import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { applyInventoryLotTracking } from '../inventory/inventory-lot-tracking';
import { applyInventorySerialTracking } from '../inventory/inventory-serial-tracking';
import { applyInventoryValuation } from '../inventory/inventory-valuation';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { PosIdempotencyConflictError } from './pos.errors';
import { SaleReturnSettlementRepository } from './sale-return-settlement.repository';
import {
  SaleReturnData,
  SaleReturnExchangeError,
  SaleReturnNotAllowedError,
  SaleReturnQuantityError,
  SaleReturnSerialError,
} from './sale-return.types';

interface SaleLineRow {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  quantity: string;
  subtotal: string;
  tax: string;
  total: string;
  track_serials: number | boolean;
}

interface SourceMovementRow {
  id: string;
  location_id: string;
  quantity_change: string;
  returned_quantity: string;
}

interface ReturnRow {
  id: string;
  tenant_id: string;
  sale_id: string;
  exchange_sale_id: string | null;
  exchange_receipt_number: string | null;
  reason: string;
  settlement_status: 'PENDING' | 'PARTIALLY_SETTLED' | 'SETTLED';
  subtotal: string;
  tax_total: string;
  total: string;
  returned_by_user_id: string;
  returned_by_email: string;
  created_at: Date | string;
  request_fingerprint: string;
}

@Injectable()
export class SaleReturnRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly settlements: SaleReturnSettlementRepository,
  ) {}

  async listBySale(
    tenantId: string,
    branchId: string,
    saleId: string,
  ): Promise<SaleReturnData[] | null> {
    const [sale] = await this.dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM sales WHERE id = ? AND tenant_id = ? AND branch_id = ? LIMIT 1',
      [saleId, tenantId, branchId],
    );
    if (!sale) return null;
    const rows = await this.dataSource.query<ReturnRow[]>(
      `${this.returnSelect()}
       WHERE sr.tenant_id = ? AND sr.sale_id = ?
       ORDER BY sr.created_at, sr.id`,
      [tenantId, saleId],
    );
    const result: SaleReturnData[] = [];
    for (const row of rows)
      result.push(await this.toData(this.dataSource.manager, row));
    return result;
  }

  async getById(
    tenantId: string,
    branchId: string,
    saleId: string,
    returnId: string,
  ): Promise<SaleReturnData | null> {
    const [row] = await this.dataSource.query<ReturnRow[]>(
      `${this.returnSelect()}
       INNER JOIN sales source_sale
         ON source_sale.id = sr.sale_id AND source_sale.tenant_id = sr.tenant_id
       WHERE sr.tenant_id = ? AND sr.sale_id = ? AND sr.id = ?
         AND source_sale.branch_id = ? LIMIT 1`,
      [tenantId, saleId, returnId, branchId],
    );
    return row ? this.toData(this.dataSource.manager, row) : null;
  }

  async create(input: {
    tenantId: string;
    branchId: string;
    userId: string;
    saleId: string;
    idempotencyKey: string;
    fingerprint: string;
    correlationId: string;
    dto: CreateSaleReturnDto;
  }): Promise<{ saleReturn: SaleReturnData; replay: boolean } | null> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) return this.replay(manager, existing, input);

          const [sale] = await manager.query<
            Array<{
              id: string;
              receipt_number: string;
              status: 'COMPLETED' | 'VOIDED';
            }>
          >(
            `SELECT id, receipt_number, status FROM sales
             WHERE id = ? AND tenant_id = ? AND branch_id = ? LIMIT 1 FOR UPDATE`,
            [input.saleId, input.tenantId, input.branchId],
          );
          if (!sale) return null;
          if (sale.status !== 'COMPLETED')
            throw new SaleReturnNotAllowedError();

          const concurrentReplay = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (concurrentReplay)
            return this.replay(manager, concurrentReplay, input);

          if (input.dto.exchangeSaleId) {
            const [exchange] = await manager.query<
              Array<{ id: string; status: string }>
            >(
              `SELECT id, status FROM sales
               WHERE id = ? AND tenant_id = ? AND branch_id = ? LIMIT 1 FOR UPDATE`,
              [input.dto.exchangeSaleId, input.tenantId, input.branchId],
            );
            if (
              !exchange ||
              exchange.id === sale.id ||
              exchange.status !== 'COMPLETED'
            ) {
              throw new SaleReturnExchangeError();
            }
            const [alreadyLinked] = await manager.query<Array<{ id: string }>>(
              `SELECT id FROM sale_returns
               WHERE tenant_id = ? AND exchange_sale_id = ? LIMIT 1 FOR UPDATE`,
              [input.tenantId, exchange.id],
            );
            if (alreadyLinked) throw new SaleReturnExchangeError();
          }

          const requestedIds = input.dto.lines.map((line) => line.saleLineId);
          if (new Set(requestedIds).size !== requestedIds.length)
            throw new SaleReturnQuantityError();
          const placeholders = requestedIds.map(() => '?').join(',');
          const saleLines = await manager.query<SaleLineRow[]>(
            `SELECT sl.id, sl.product_id, sl.product_name, sl.product_sku,
                    sl.quantity, sl.subtotal, sl.tax, sl.total, p.track_serials
             FROM sale_lines sl
             INNER JOIN products p
               ON p.id = sl.product_id AND p.tenant_id = sl.tenant_id
             WHERE sl.tenant_id = ? AND sl.sale_id = ? AND sl.id IN (${placeholders})
             ORDER BY sl.line_number FOR UPDATE`,
            [input.tenantId, sale.id, ...requestedIds],
          );
          if (saleLines.length !== requestedIds.length)
            throw new SaleReturnQuantityError();
          const byId = new Map(saleLines.map((line) => [line.id, line]));

          const prepared = [] as Array<{
            source: SaleLineRow;
            quantity: bigint;
            condition: 'SELLABLE' | 'DAMAGED';
            serialNumbers: string[];
            subtotal: bigint;
            tax: bigint;
            total: bigint;
            allocations: Array<{
              movementId: string;
              locationId: string;
              quantity: bigint;
              serialNumbers: string[];
            }>;
          }>;
          for (const requested of input.dto.lines) {
            const source = byId.get(requested.saleLineId)!;
            const quantity = this.toQuantity(requested.quantity);
            const [accumulated] = await manager.query<
              Array<{
                quantity: string;
                subtotal: string;
                tax: string;
                total: string;
              }>
            >(
              `SELECT COALESCE(SUM(quantity), 0) AS quantity,
                      COALESCE(SUM(subtotal), 0) AS subtotal,
                      COALESCE(SUM(tax), 0) AS tax,
                      COALESCE(SUM(total), 0) AS total
               FROM sale_return_lines
               WHERE tenant_id = ? AND sale_line_id = ?`,
              [input.tenantId, source.id],
            );
            const returned = this.toQuantity(accumulated.quantity);
            const sold = this.toQuantity(source.quantity);
            if (quantity <= 0n || returned + quantity > sold)
              throw new SaleReturnQuantityError();

            const serialNumbers = (requested.serialNumbers ?? []).map((value) =>
              value.trim(),
            );
            if (
              Boolean(source.track_serials) !== serialNumbers.length > 0 ||
              (Boolean(source.track_serials) &&
                (quantity % 1000n !== 0n ||
                  BigInt(serialNumbers.length) !== quantity / 1000n))
            ) {
              throw new SaleReturnSerialError();
            }
            if (
              new Set(serialNumbers.map((value) => value.toUpperCase()))
                .size !== serialNumbers.length
            ) {
              throw new SaleReturnSerialError();
            }

            const sourceMovements = await manager.query<SourceMovementRow[]>(
              `SELECT source.id, source.location_id, source.quantity_change,
                      COALESCE(SUM(restored.quantity_change), 0) AS returned_quantity
               FROM inventory_movements source
               LEFT JOIN inventory_movements restored
                 ON restored.tenant_id = source.tenant_id
                AND restored.source_sale_movement_id = source.id
                AND restored.type = 'SALE_RETURN'
               WHERE source.tenant_id = ? AND source.sale_id = ?
                 AND source.sale_line_id = ? AND source.type = 'SALE'
               GROUP BY source.id, source.location_id, source.quantity_change,
                        source.created_at
               ORDER BY source.created_at, source.id FOR UPDATE`,
              [input.tenantId, sale.id, source.id],
            );
            const serialSource = await this.serialSources(
              manager,
              input.tenantId,
              sourceMovements.map((movement) => movement.id),
              serialNumbers,
            );
            const allocations = [] as Array<{
              movementId: string;
              locationId: string;
              quantity: bigint;
              serialNumbers: string[];
            }>;
            let remaining = quantity;
            for (const movement of sourceMovements) {
              if (remaining === 0n) break;
              const soldAtLocation = -this.toQuantity(movement.quantity_change);
              const available =
                soldAtLocation - this.toQuantity(movement.returned_quantity);
              const movementSerials = serialNumbers.filter(
                (serial) =>
                  serialSource.get(serial.toUpperCase()) === movement.id,
              );
              const selected = source.track_serials
                ? BigInt(movementSerials.length) * 1000n
                : available < remaining
                  ? available
                  : remaining;
              if (selected <= 0n) continue;
              if (selected > available || selected > remaining)
                throw new SaleReturnSerialError();
              allocations.push({
                movementId: movement.id,
                locationId: movement.location_id,
                quantity: selected,
                serialNumbers: movementSerials,
              });
              remaining -= selected;
            }
            if (remaining !== 0n) throw new SaleReturnQuantityError();

            const completesLine = returned + quantity === sold;
            const subtotal = this.prorate(
              this.toMoney(source.subtotal),
              sold,
              quantity,
              this.toMoney(accumulated.subtotal),
              completesLine,
            );
            const tax = this.prorate(
              this.toMoney(source.tax),
              sold,
              quantity,
              this.toMoney(accumulated.tax),
              completesLine,
            );
            prepared.push({
              source,
              quantity,
              condition: requested.condition,
              serialNumbers,
              subtotal,
              tax,
              total: subtotal + tax,
              allocations,
            });
          }

          const returnId = randomUUID();
          const subtotal = prepared.reduce(
            (sum, line) => sum + line.subtotal,
            0n,
          );
          const tax = prepared.reduce((sum, line) => sum + line.tax, 0n);
          const total = subtotal + tax;
          await manager.query(
            `INSERT INTO sale_returns
              (id, tenant_id, sale_id, exchange_sale_id, reason,
               settlement_status, subtotal, tax_total, total, idempotency_key,
               request_fingerprint, returned_by_user_id)
             VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
            [
              returnId,
              input.tenantId,
              sale.id,
              input.dto.exchangeSaleId ?? null,
              input.dto.reason,
              this.money(subtotal),
              this.money(tax),
              this.money(total),
              input.idempotencyKey,
              input.fingerprint,
              input.userId,
            ],
          );

          for (const [index, line] of prepared.entries()) {
            const returnLineId = randomUUID();
            await manager.query(
              `INSERT INTO sale_return_lines
                (id, tenant_id, sale_return_id, sale_line_id, product_id,
                 line_number, quantity, item_condition, subtotal, tax, total,
                 serial_numbers)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                returnLineId,
                input.tenantId,
                returnId,
                line.source.id,
                line.source.product_id,
                index + 1,
                this.quantity(line.quantity),
                line.condition,
                this.money(line.subtotal),
                this.money(line.tax),
                this.money(line.total),
                JSON.stringify(line.serialNumbers),
              ],
            );
            for (const allocation of line.allocations) {
              const [balance] = await manager.query<
                Array<{
                  quantity: string;
                  available_quantity: string;
                  damaged_quantity: string;
                }>
              >(
                `SELECT quantity, available_quantity, damaged_quantity
                 FROM inventory_balances
                 WHERE tenant_id = ? AND product_id = ? AND location_id = ?
                 LIMIT 1 FOR UPDATE`,
                [input.tenantId, line.source.product_id, allocation.locationId],
              );
              if (!balance) throw new Error('SALE_RETURN_BALANCE_NOT_FOUND');
              const nextQuantity =
                this.toQuantity(balance.quantity) + allocation.quantity;
              const nextAvailable =
                this.toQuantity(balance.available_quantity) +
                (line.condition === 'SELLABLE' ? allocation.quantity : 0n);
              const nextDamaged =
                this.toQuantity(balance.damaged_quantity) +
                (line.condition === 'DAMAGED' ? allocation.quantity : 0n);
              await manager.query(
                `UPDATE inventory_balances
                 SET quantity = ?, available_quantity = ?, damaged_quantity = ?
                 WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
                [
                  this.quantity(nextQuantity),
                  this.quantity(nextAvailable),
                  this.quantity(nextDamaged),
                  input.tenantId,
                  line.source.product_id,
                  allocation.locationId,
                ],
              );
              const movementId = randomUUID();
              const movementFingerprint = createHash('sha256')
                .update(
                  JSON.stringify({
                    returnId,
                    returnLineId,
                    sourceSaleMovementId: allocation.movementId,
                    quantity: this.quantity(allocation.quantity),
                    condition: line.condition,
                  }),
                )
                .digest('hex');
              await manager.query(
                `INSERT INTO inventory_movements
                  (id, tenant_id, product_id, location_id, type, from_state,
                   to_state, state_quantity, quantity_change, resulting_quantity,
                   reason, reference, idempotency_key, request_fingerprint,
                   created_by_user_id, sale_id, sale_line_id, sale_return_id,
                   sale_return_line_id, source_sale_movement_id)
                 VALUES (?, ?, ?, ?, 'SALE_RETURN', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  movementId,
                  input.tenantId,
                  line.source.product_id,
                  allocation.locationId,
                  line.condition === 'SELLABLE' ? 'AVAILABLE' : 'DAMAGED',
                  this.quantity(allocation.quantity),
                  this.quantity(allocation.quantity),
                  this.quantity(nextQuantity),
                  input.dto.reason,
                  sale.receipt_number,
                  `sale-return:${returnId}:${allocation.movementId}`,
                  movementFingerprint,
                  input.userId,
                  sale.id,
                  line.source.id,
                  returnId,
                  returnLineId,
                  allocation.movementId,
                ],
              );
              await applyInventoryValuation(manager, movementId);
              await applyInventoryLotTracking(manager, movementId);
              await applyInventorySerialTracking(manager, movementId, {
                serialNumbers: allocation.serialNumbers,
              });
            }
          }
          await this.audit.recordInTransaction(manager, {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: 'SALE_RETURNED',
            entityType: 'SALE_RETURN',
            entityId: returnId,
            correlationId: input.correlationId,
            deduplicate: true,
            after: {
              saleId: sale.id,
              exchangeSaleId: input.dto.exchangeSaleId ?? null,
              reason: input.dto.reason,
              total: this.money(total),
              lineCount: prepared.length,
              settlementStatus: 'PENDING',
            },
          });
          const created = await this.findById(
            manager,
            input.tenantId,
            returnId,
          );
          if (!created) throw new Error('SALE_RETURN_NOT_FOUND_AFTER_CREATE');
          return {
            saleReturn: await this.toData(manager, created),
            replay: false,
          };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!existing) throw error;
      return this.replay(this.dataSource.manager, existing, input);
    }
  }

  private async serialSources(
    manager: EntityManager,
    tenantId: string,
    movementIds: string[],
    serialNumbers: string[],
  ): Promise<Map<string, string>> {
    if (serialNumbers.length === 0) return new Map();
    const movementPlaceholders = movementIds.map(() => '?').join(',');
    const serialPlaceholders = serialNumbers.map(() => '?').join(',');
    const rows = await manager.query<
      Array<{ normalized_serial: string; movement_id: string }>
    >(
      `SELECT serial.normalized_serial, source.id AS movement_id
       FROM inventory_serials serial
       INNER JOIN inventory_serial_events event
         ON event.serial_id = serial.id AND event.tenant_id = serial.tenant_id
       INNER JOIN inventory_movements source
         ON source.id = event.movement_id AND source.tenant_id = event.tenant_id
       WHERE serial.tenant_id = ? AND serial.status = 'SOLD'
         AND source.id IN (${movementPlaceholders}) AND source.type = 'SALE'
         AND event.to_status = 'SOLD'
         AND serial.normalized_serial IN (${serialPlaceholders})
       FOR UPDATE`,
      [
        tenantId,
        ...movementIds,
        ...serialNumbers.map((value) => value.toUpperCase()),
      ],
    );
    if (rows.length !== serialNumbers.length) throw new SaleReturnSerialError();
    return new Map(rows.map((row) => [row.normalized_serial, row.movement_id]));
  }

  private async replay(
    manager: EntityManager,
    existing: ReturnRow,
    input: { saleId: string; fingerprint: string },
  ) {
    if (
      existing.sale_id !== input.saleId ||
      existing.request_fingerprint !== input.fingerprint
    ) {
      throw new PosIdempotencyConflictError();
    }
    return {
      saleReturn: await this.toData(manager, existing),
      replay: true as const,
    };
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ReturnRow | null> {
    const [row] = await manager.query<ReturnRow[]>(
      `${this.returnSelect()}
       WHERE sr.tenant_id = ? AND sr.idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return row ?? null;
  }

  private async findById(
    manager: EntityManager,
    tenantId: string,
    returnId: string,
  ): Promise<ReturnRow | null> {
    const [row] = await manager.query<ReturnRow[]>(
      `${this.returnSelect()}
       WHERE sr.tenant_id = ? AND sr.id = ? LIMIT 1`,
      [tenantId, returnId],
    );
    return row ?? null;
  }

  private returnSelect(): string {
    return `SELECT sr.id, sr.tenant_id, sr.sale_id, sr.exchange_sale_id,
                   exchange_sale.receipt_number AS exchange_receipt_number,
                   sr.reason, sr.settlement_status, sr.subtotal, sr.tax_total,
                   sr.total, sr.returned_by_user_id,
                   returned_by.email AS returned_by_email, sr.created_at,
                   sr.request_fingerprint
            FROM sale_returns sr
            INNER JOIN users returned_by
              ON returned_by.id = sr.returned_by_user_id
             AND returned_by.tenant_id = sr.tenant_id
            LEFT JOIN sales exchange_sale
              ON exchange_sale.id = sr.exchange_sale_id
             AND exchange_sale.tenant_id = sr.tenant_id`;
  }

  private async toData(
    manager: EntityManager,
    row: ReturnRow,
  ): Promise<SaleReturnData> {
    const settlements = await this.settlements.list(
      manager,
      row.tenant_id,
      row.id,
    );
    const settled = settlements
      .filter(({ status }) => status === 'COMPLETED')
      .reduce((sum, settlement) => sum + this.toMoney(settlement.amount), 0n);
    const refundable = this.toMoney(row.total) - settled;
    const lines = await manager.query<
      Array<{
        id: string;
        sale_line_id: string;
        product_id: string;
        product_name: string;
        product_sku: string;
        quantity: string;
        item_condition: 'SELLABLE' | 'DAMAGED';
        subtotal: string;
        tax: string;
        total: string;
        serial_numbers: string | string[];
      }>
    >(
      `SELECT srl.id, srl.sale_line_id, srl.product_id,
              sl.product_name, sl.product_sku, srl.quantity,
              srl.item_condition, srl.subtotal, srl.tax, srl.total,
              srl.serial_numbers
       FROM sale_return_lines srl
       INNER JOIN sale_lines sl
         ON sl.id = srl.sale_line_id AND sl.tenant_id = srl.tenant_id
       WHERE srl.tenant_id = ? AND srl.sale_return_id = ?
       ORDER BY srl.line_number`,
      [row.tenant_id, row.id],
    );
    return {
      id: row.id,
      saleId: row.sale_id,
      exchangeSale:
        row.exchange_sale_id && row.exchange_receipt_number
          ? {
              id: row.exchange_sale_id,
              receiptNumber: row.exchange_receipt_number,
            }
          : null,
      reason: row.reason,
      settlementStatus: row.settlement_status,
      refundableAmount: this.money(refundable),
      totals: {
        subtotal: this.decimal(row.subtotal, 2),
        tax: this.decimal(row.tax_total, 2),
        total: this.decimal(row.total, 2),
      },
      returnedBy: { id: row.returned_by_user_id, email: row.returned_by_email },
      createdAt: new Date(row.created_at).toISOString(),
      settlements,
      lines: lines.map((line) => ({
        id: line.id,
        saleLineId: line.sale_line_id,
        product: {
          id: line.product_id,
          name: line.product_name,
          sku: line.product_sku,
        },
        quantity: this.decimal(line.quantity, 3),
        condition: line.item_condition,
        totals: {
          subtotal: this.decimal(line.subtotal, 2),
          tax: this.decimal(line.tax, 2),
          total: this.decimal(line.total, 2),
        },
        serialNumbers: this.json<string[]>(line.serial_numbers),
      })),
    };
  }

  private prorate(
    original: bigint,
    sold: bigint,
    returnedNow: bigint,
    returnedMoney: bigint,
    completesLine: boolean,
  ): bigint {
    return completesLine
      ? original - returnedMoney
      : (original * returnedNow + sold / 2n) / sold;
  }

  private toQuantity(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  }

  private quantity(value: bigint): string {
    return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
  }

  private toMoney(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  }

  private money(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = String(value).split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }

  private json<T>(value: string | T): T {
    return typeof value === 'string' ? (JSON.parse(value) as T) : value;
  }

  private isDuplicate(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driver = error.driverError as { code?: string; errno?: number };
    return driver.code === 'ER_DUP_ENTRY' || driver.errno === 1062;
  }
}

import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { applyInventoryValuation } from '../inventory/inventory-valuation';
import { applyInventoryLotTracking } from '../inventory/inventory-lot-tracking';
import { applyInventorySerialTracking } from '../inventory/inventory-serial-tracking';
import { ReturnPurchaseReceiptDto } from './dto/return-purchase-receipt.dto';
import {
  InvalidPurchaseReturnError,
  PurchaseOrderIdempotencyConflictError,
  PurchaseReturnQuantityError,
  PurchaseReturnStockError,
} from './purchase-order.errors';
import {
  normalizeProductQuantity,
  ProductBaseUnit,
  ProductQuantityPolicy,
  QuantityRoundingMode,
} from '../common/quantity-policy';

interface ReturnRequestRow {
  id: string;
  purchase_order_id: string;
  purchase_receipt_id: string;
  request_fingerprint: string;
  warehouse_id: string;
}

interface ReceiptLineRow {
  id: string;
  product_id: string;
  received_quantity: string;
  unit_cost: string;
}

@Injectable()
export class PurchaseReturnRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: {
    tenantId: string;
    orderId: string;
    actorUserId: string;
    warehouseId: string;
    idempotencyKey: string;
    dto: ReturnPurchaseReceiptDto;
  }): Promise<{ returnId: string; replay: boolean }> {
    const lineIds = input.dto.lines.map((line) => line.purchaseReceiptLineId);
    if (new Set(lineIds).size !== lineIds.length)
      throw new InvalidPurchaseReturnError();
    const policies = await this.quantityPolicies(
      input.tenantId,
      input.dto.purchaseReceiptId,
      lineIds,
    );
    const lines = input.dto.lines.map((line) => {
      const policy = policies.get(line.purchaseReceiptLineId);
      if (!policy) throw new InvalidPurchaseReturnError();
      return {
        purchaseReceiptLineId: line.purchaseReceiptLineId,
        returnedQuantity: normalizeProductQuantity(
          line.returnedQuantity,
          policy,
        ),
        serialNumbers: line.serialNumbers ?? [],
      };
    });
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          orderId: input.orderId,
          purchaseReceiptId: input.dto.purchaseReceiptId,
          documentReference: input.dto.documentReference,
          reason: input.dto.reason,
          lines: [...lines].sort((left, right) =>
            left.purchaseReceiptLineId.localeCompare(
              right.purchaseReceiptLineId,
            ),
          ),
        }),
      )
      .digest('hex');

    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) return this.replay(existing, input, fingerprint);

          const [receipt] = await manager.query<
            Array<{
              purchase_order_id: string;
              location_id: string;
              order_folio: string;
            }>
          >(
            `SELECT pr.purchase_order_id, pr.location_id, po.folio AS order_folio
           FROM purchase_receipts pr
           INNER JOIN purchase_orders po
             ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
           INNER JOIN locations l
             ON l.id = pr.location_id AND l.tenant_id = pr.tenant_id
           WHERE pr.id = ? AND pr.tenant_id = ? AND pr.purchase_order_id = ?
             AND l.warehouse_id = ? AND l.active = TRUE
           FOR UPDATE`,
            [
              input.dto.purchaseReceiptId,
              input.tenantId,
              input.orderId,
              input.warehouseId,
            ],
          );
          if (!receipt) throw new InvalidPurchaseReturnError();
          const concurrentReplay = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (concurrentReplay)
            return this.replay(concurrentReplay, input, fingerprint);

          const receiptLines = await manager.query<ReceiptLineRow[]>(
            `SELECT prl.id, pol.product_id, prl.received_quantity, prl.unit_cost
           FROM purchase_receipt_lines prl
           INNER JOIN purchase_order_lines pol
             ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
           WHERE prl.tenant_id = ? AND prl.receipt_id = ? FOR UPDATE`,
            [input.tenantId, input.dto.purchaseReceiptId],
          );
          const byId = new Map(receiptLines.map((line) => [line.id, line]));
          const requested = [] as Array<{
            receiptLine: ReceiptLineRow;
            returned: bigint;
            totalCost: string;
            serialNumbers: string[];
          }>;
          for (const line of lines) {
            const receiptLine = byId.get(line.purchaseReceiptLineId);
            if (!receiptLine) throw new InvalidPurchaseReturnError();
            const returned = this.toUnits(line.returnedQuantity);
            const [accumulated] = await manager.query<
              Array<{ quantity: string }>
            >(
              `SELECT COALESCE(SUM(returned_quantity), 0) AS quantity
             FROM purchase_return_lines
             WHERE tenant_id = ? AND purchase_receipt_line_id = ?`,
              [input.tenantId, receiptLine.id],
            );
            if (
              returned <= 0n ||
              this.toUnits(accumulated.quantity) + returned >
                this.toUnits(receiptLine.received_quantity)
            ) {
              throw new PurchaseReturnQuantityError();
            }
            requested.push({
              receiptLine,
              returned,
              totalCost: this.lineCost(returned, receiptLine.unit_cost),
              serialNumbers: line.serialNumbers,
            });
          }

          const returnId = randomUUID();
          const expectedCreditTotal = this.money(
            requested.reduce(
              (total, line) => total + this.toMoney(line.totalCost),
              0n,
            ),
          );
          await manager.query(
            `INSERT INTO purchase_returns
            (id, tenant_id, purchase_order_id, purchase_receipt_id, location_id,
             document_reference, reason, expected_credit_total, idempotency_key,
             request_fingerprint, returned_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              returnId,
              input.tenantId,
              input.orderId,
              input.dto.purchaseReceiptId,
              receipt.location_id,
              input.dto.documentReference,
              input.dto.reason,
              expectedCreditTotal,
              input.idempotencyKey,
              fingerprint,
              input.actorUserId,
            ],
          );

          for (const [index, item] of requested.entries()) {
            const returnLineId = randomUUID();
            const [balance] = await manager.query<
              Array<{ quantity: string; available_quantity: string }>
            >(
              `SELECT quantity, available_quantity FROM inventory_balances
             WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
              [
                input.tenantId,
                item.receiptLine.product_id,
                receipt.location_id,
              ],
            );
            if (
              !balance ||
              this.toUnits(balance.quantity) < item.returned ||
              this.toUnits(balance.available_quantity) < item.returned
            ) {
              throw new PurchaseReturnStockError();
            }
            const resultingQuantity =
              this.toUnits(balance.quantity) - item.returned;
            const resultingAvailable =
              this.toUnits(balance.available_quantity) - item.returned;
            const movementId = randomUUID();
            await manager.query(
              `UPDATE inventory_balances
             SET quantity = ?, available_quantity = ?
             WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                this.fromUnits(resultingQuantity),
                this.fromUnits(resultingAvailable),
                input.tenantId,
                item.receiptLine.product_id,
                receipt.location_id,
              ],
            );
            await manager.query(
              `INSERT INTO purchase_return_lines
              (id, tenant_id, purchase_return_id, purchase_receipt_line_id,
               product_id, line_number, returned_quantity, unit_cost, total_cost)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                returnLineId,
                input.tenantId,
                returnId,
                item.receiptLine.id,
                item.receiptLine.product_id,
                index + 1,
                this.fromUnits(item.returned),
                item.receiptLine.unit_cost,
                item.totalCost,
              ],
            );
            const movementFingerprint = createHash('sha256')
              .update(
                JSON.stringify({
                  returnId,
                  returnLineId,
                  productId: item.receiptLine.product_id,
                  locationId: receipt.location_id,
                  quantity: this.fromUnits(item.returned),
                }),
              )
              .digest('hex');
            await manager.query(
              `INSERT INTO inventory_movements
              (id, tenant_id, product_id, location_id, type, quantity_change,
               resulting_quantity, reason, reference, idempotency_key,
               request_fingerprint, created_by_user_id, purchase_return_id,
               purchase_return_line_id)
             VALUES (?, ?, ?, ?, 'SUPPLIER_RETURN', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                movementId,
                input.tenantId,
                item.receiptLine.product_id,
                receipt.location_id,
                this.fromUnits(-item.returned),
                this.fromUnits(resultingQuantity),
                input.dto.reason,
                input.dto.documentReference,
                `supplier-return:${returnId}:${index + 1}`,
                movementFingerprint,
                input.actorUserId,
                returnId,
                returnLineId,
              ],
            );
            await applyInventoryValuation(manager, movementId);
            await applyInventoryLotTracking(manager, movementId);
            await applyInventorySerialTracking(manager, movementId, {
              serialNumbers: item.serialNumbers,
            });
          }
          return { returnId, replay: false };
        },
      );
    } catch (error) {
      if (this.isDuplicate(error)) {
        const existing = await this.findByKey(
          this.dataSource.manager,
          input.tenantId,
          input.idempotencyKey,
        );
        if (existing) return this.replay(existing, input, fingerprint);
      }
      throw error;
    }
  }

  private replay(
    existing: ReturnRequestRow,
    input: {
      orderId: string;
      warehouseId: string;
      dto: ReturnPurchaseReceiptDto;
    },
    fingerprint: string,
  ): { returnId: string; replay: true } {
    if (
      existing.purchase_order_id !== input.orderId ||
      existing.purchase_receipt_id !== input.dto.purchaseReceiptId ||
      existing.warehouse_id !== input.warehouseId ||
      existing.request_fingerprint !== fingerprint
    ) {
      throw new PurchaseOrderIdempotencyConflictError();
    }
    return { returnId: existing.id, replay: true };
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ReturnRequestRow | null> {
    const [row] = await manager.query<ReturnRequestRow[]>(
      `SELECT pr.id, pr.purchase_order_id, pr.purchase_receipt_id,
              pr.request_fingerprint, l.warehouse_id
       FROM purchase_returns pr
       INNER JOIN locations l ON l.id = pr.location_id AND l.tenant_id = pr.tenant_id
       WHERE pr.tenant_id = ? AND pr.idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return row ?? null;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }

  private async quantityPolicies(
    tenantId: string,
    receiptId: string,
    lineIds: string[],
  ): Promise<Map<string, ProductQuantityPolicy>> {
    const rows = await this.dataSource.query<
      Array<{
        line_id: string;
        base_unit: ProductBaseUnit;
        quantity_precision: number;
        quantity_rounding: QuantityRoundingMode;
        minimum_quantity: string;
      }>
    >(
      `SELECT prl.id AS line_id, p.base_unit, p.quantity_precision,
              p.quantity_rounding, p.minimum_quantity
       FROM purchase_receipt_lines prl
       INNER JOIN purchase_order_lines pol
         ON pol.id = prl.purchase_order_line_id AND pol.tenant_id = prl.tenant_id
       INNER JOIN products p ON p.id = pol.product_id AND p.tenant_id = pol.tenant_id
       WHERE prl.tenant_id = ? AND prl.receipt_id = ?
         AND prl.id IN (${lineIds.map(() => '?').join(',')})`,
      [tenantId, receiptId, ...lineIds],
    );
    return new Map(
      rows.map((row) => [
        row.line_id,
        {
          baseUnit: row.base_unit,
          precision: Number(row.quantity_precision),
          rounding: row.quantity_rounding,
          minimumQuantity: row.minimum_quantity,
        },
      ]),
    );
  }

  private toUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(3, '0')}`);
  }

  private fromUnits(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 1000n}.${(absolute % 1000n).toString().padStart(3, '0')}`;
  }

  private lineCost(quantity: bigint, unitCost: string): string {
    const totalCents = (quantity * this.toMoney(unitCost) + 500n) / 1000n;
    return this.money(totalCents);
  }

  private toMoney(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(2, '0')}`);
  }

  private money(cents: bigint): string {
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  }
}

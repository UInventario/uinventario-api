import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { applyInventoryValuation } from '../inventory/inventory-valuation';
import { applyInventoryLotTracking } from '../inventory/inventory-lot-tracking';
import { applyInventorySerialTracking } from '../inventory/inventory-serial-tracking';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import {
  InvalidPurchaseReceiptError,
  PurchaseOrderIdempotencyConflictError,
  PurchaseOrderNotFoundError,
  PurchaseOrderStateError,
  PurchaseOrderVersionConflictError,
  PurchaseReceiptLocationError,
  PurchaseReceiptOveragePermissionError,
  PurchaseReceiptOverageReasonError,
} from './purchase-order.errors';
import type { PurchaseOrderStatus } from './purchase-order.types';

interface ReceiptRequestRow {
  id: string;
  purchase_order_id: string;
  request_fingerprint: string;
  warehouse_id: string;
}

interface OrderLineRow {
  id: string;
  product_id: string;
  quantity: string;
  received_quantity: string;
  unit_cost: string;
}

@Injectable()
export class PurchaseReceiptRepository {
  constructor(private readonly dataSource: DataSource) {}

  async receive(input: {
    tenantId: string;
    orderId: string;
    warehouseId: string;
    actorUserId: string;
    allowOverage: boolean;
    idempotencyKey: string;
    dto: ReceivePurchaseOrderDto;
  }): Promise<{ receiptId: string; replay: boolean }> {
    const lineIds = input.dto.lines.map((line) => line.purchaseOrderLineId);
    if (new Set(lineIds).size !== lineIds.length)
      throw new InvalidPurchaseReceiptError();
    const lines = input.dto.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      receivedQuantity: this.fromUnits(this.toUnits(line.receivedQuantity)),
      lotCode: line.lotCode ?? null,
      serialNumbers: line.serialNumbers ?? [],
    }));
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          orderId: input.orderId,
          version: input.dto.version,
          locationId: input.dto.locationId,
          documentReference: input.dto.documentReference,
          overageReason: input.dto.overageReason ?? null,
          lines: [...lines].sort((left, right) =>
            left.purchaseOrderLineId.localeCompare(right.purchaseOrderLineId),
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

          const [order] = await manager.query<
            Array<{
              status: PurchaseOrderStatus;
              version: number | string;
              folio: string;
            }>
          >(
            `SELECT status, version, folio FROM purchase_orders
             WHERE id = ? AND tenant_id = ? FOR UPDATE`,
            [input.orderId, input.tenantId],
          );
          if (!order) throw new PurchaseOrderNotFoundError();
          const concurrentReplay = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (concurrentReplay)
            return this.replay(concurrentReplay, input, fingerprint);
          if (Number(order.version) !== input.dto.version)
            throw new PurchaseOrderVersionConflictError(Number(order.version));
          if (
            !['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(
              order.status,
            )
          ) {
            throw new PurchaseOrderStateError(order.status);
          }

          const [location] = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM locations
             WHERE id = ? AND tenant_id = ? AND warehouse_id = ? AND active = TRUE
             LIMIT 1`,
            [input.dto.locationId, input.tenantId, input.warehouseId],
          );
          if (!location) throw new PurchaseReceiptLocationError();

          const orderLines = await manager.query<OrderLineRow[]>(
            `SELECT id, product_id, quantity, received_quantity, unit_cost
             FROM purchase_order_lines
             WHERE tenant_id = ? AND purchase_order_id = ? FOR UPDATE`,
            [input.tenantId, input.orderId],
          );
          const byId = new Map(orderLines.map((line) => [line.id, line]));
          const requested = lines.map((line) => {
            const orderLine = byId.get(line.purchaseOrderLineId);
            if (!orderLine) throw new InvalidPurchaseReceiptError();
            const received = this.toUnits(line.receivedQuantity);
            if (received <= 0n) throw new InvalidPurchaseReceiptError();
            const ordered = this.toUnits(orderLine.quantity);
            const accumulated = this.toUnits(orderLine.received_quantity);
            const pending = ordered > accumulated ? ordered - accumulated : 0n;
            const overage = received > pending ? received - pending : 0n;
            return {
              orderLine,
              received,
              overage,
              lotCode: line.lotCode ?? null,
              serialNumbers: line.serialNumbers,
            };
          });
          const hasOverage = requested.some(({ overage }) => overage > 0n);
          if (hasOverage && !input.allowOverage)
            throw new PurchaseReceiptOveragePermissionError();
          if (hasOverage && !input.dto.overageReason)
            throw new PurchaseReceiptOverageReasonError();

          const receiptId = randomUUID();
          await manager.query(
            `INSERT INTO purchase_receipts
              (id, tenant_id, purchase_order_id, location_id, document_reference,
               overage_reason, idempotency_key, request_fingerprint,
               received_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              receiptId,
              input.tenantId,
              input.orderId,
              input.dto.locationId,
              input.dto.documentReference,
              hasOverage ? input.dto.overageReason : null,
              input.idempotencyKey,
              fingerprint,
              input.actorUserId,
            ],
          );
          for (const [index, item] of requested.entries()) {
            const receiptLineId = randomUUID();
            const [product] = await manager.query<
              Array<{
                cost: string;
                track_lots: number | boolean;
                track_serials: number | boolean;
              }>
            >(
              `SELECT cost, track_lots, track_serials FROM products
               WHERE id = ? AND tenant_id = ? FOR UPDATE`,
              [item.orderLine.product_id, input.tenantId],
            );
            if (!product) throw new InvalidPurchaseReceiptError();
            if (Boolean(product.track_lots) && !item.lotCode)
              throw new InvalidPurchaseReceiptError();
            if (
              Boolean(product.track_serials) &&
              BigInt(item.serialNumbers.length) * 1000n !== item.received
            )
              throw new InvalidPurchaseReceiptError();
            const movementId = randomUUID();
            await manager.query(
              `INSERT INTO inventory_balances
                (tenant_id, product_id, location_id, quantity)
               VALUES (?, ?, ?, 0)
               ON DUPLICATE KEY UPDATE quantity = quantity`,
              [input.tenantId, item.orderLine.product_id, input.dto.locationId],
            );
            const [balance] = await manager.query<
              Array<{ quantity: string; available_quantity: string }>
            >(
              `SELECT quantity, available_quantity FROM inventory_balances
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?
               FOR UPDATE`,
              [input.tenantId, item.orderLine.product_id, input.dto.locationId],
            );
            const resultingQuantity =
              this.toUnits(balance.quantity) + item.received;
            const resultingAvailable =
              this.toUnits(balance.available_quantity) + item.received;
            await manager.query(
              `UPDATE inventory_balances
               SET quantity = ?, available_quantity = ?
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                this.fromUnits(resultingQuantity),
                this.fromUnits(resultingAvailable),
                input.tenantId,
                item.orderLine.product_id,
                input.dto.locationId,
              ],
            );
            await manager.query(
              `UPDATE purchase_order_lines
               SET received_quantity = received_quantity + ?
               WHERE id = ? AND tenant_id = ?`,
              [
                this.fromUnits(item.received),
                item.orderLine.id,
                input.tenantId,
              ],
            );
            await manager.query(
              `INSERT INTO purchase_receipt_lines
                (id, tenant_id, receipt_id, purchase_order_line_id, line_number,
                 received_quantity, lot_code, overage_quantity, unit_cost, total_cost,
                 previous_catalog_cost, resulting_catalog_cost)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                receiptLineId,
                input.tenantId,
                receiptId,
                item.orderLine.id,
                index + 1,
                this.fromUnits(item.received),
                item.lotCode,
                this.fromUnits(item.overage),
                item.orderLine.unit_cost,
                this.receiptCost(item.received, item.orderLine.unit_cost),
                product.cost,
                product.cost,
              ],
            );
            const movementFingerprint = createHash('sha256')
              .update(
                JSON.stringify({
                  receiptId,
                  receiptLineId,
                  productId: item.orderLine.product_id,
                  locationId: input.dto.locationId,
                  quantity: this.fromUnits(item.received),
                  unitCost: item.orderLine.unit_cost,
                }),
              )
              .digest('hex');
            await manager.query(
              `INSERT INTO inventory_movements
                (id, tenant_id, product_id, location_id, type, quantity_change,
                 resulting_quantity, reason, reference, idempotency_key,
                 request_fingerprint, created_by_user_id, purchase_receipt_id,
                 purchase_receipt_line_id)
               VALUES (?, ?, ?, ?, 'PURCHASE_RECEIPT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                movementId,
                input.tenantId,
                item.orderLine.product_id,
                input.dto.locationId,
                this.fromUnits(item.received),
                this.fromUnits(resultingQuantity),
                `Recepción de compra ${order.folio}`,
                input.dto.documentReference,
                `purchase-receipt:${receiptId}:${index + 1}`,
                movementFingerprint,
                input.actorUserId,
                receiptId,
                receiptLineId,
              ],
            );
            await applyInventoryValuation(manager, movementId);
            await applyInventoryLotTracking(manager, movementId);
            await applyInventorySerialTracking(manager, movementId, {
              serialNumbers: item.serialNumbers,
            });
            await manager.query(
              `UPDATE purchase_receipt_lines prl
               INNER JOIN products p
                 ON p.id = ? AND p.tenant_id = prl.tenant_id
               SET prl.resulting_catalog_cost = p.cost
               WHERE prl.id = ? AND prl.tenant_id = ?`,
              [item.orderLine.product_id, receiptLineId, input.tenantId],
            );
          }

          const [progress] = await manager.query<
            Array<{ pending: number | string }>
          >(
            `SELECT COUNT(*) AS pending FROM purchase_order_lines
             WHERE tenant_id = ? AND purchase_order_id = ?
               AND received_quantity < quantity`,
            [input.tenantId, input.orderId],
          );
          const status: PurchaseOrderStatus =
            Number(progress.pending) === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
          await manager.query(
            `UPDATE purchase_orders
             SET status = ?, version = version + 1
             WHERE id = ? AND tenant_id = ?`,
            [status, input.orderId, input.tenantId],
          );
          if (status !== order.status) {
            await manager.query(
              `INSERT INTO purchase_order_transitions
                (id, tenant_id, purchase_order_id, from_status, to_status, reason,
                 delivery_mode, delivery_recipient, idempotency_key,
                 request_fingerprint, actor_user_id)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                input.orderId,
                order.status,
                status,
                `Recepción ${input.dto.documentReference}`,
                `receipt-${receiptId}`,
                fingerprint,
                input.actorUserId,
              ],
            );
          }
          return { receiptId, replay: false };
        },
      );
    } catch (error) {
      if (
        this.isDuplicate(error) ||
        error instanceof PurchaseOrderVersionConflictError ||
        error instanceof PurchaseOrderStateError
      ) {
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
    existing: ReceiptRequestRow,
    input: { orderId: string; warehouseId: string },
    fingerprint: string,
  ): { receiptId: string; replay: true } {
    if (
      existing.purchase_order_id !== input.orderId ||
      existing.warehouse_id !== input.warehouseId ||
      existing.request_fingerprint !== fingerprint
    ) {
      throw new PurchaseOrderIdempotencyConflictError();
    }
    return { receiptId: existing.id, replay: true };
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ReceiptRequestRow | null> {
    const [row] = await manager.query<ReceiptRequestRow[]>(
      `SELECT pr.id, pr.purchase_order_id, pr.request_fingerprint, l.warehouse_id
       FROM purchase_receipts pr
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

  private toUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(3, '0')}`);
  }

  private fromUnits(value: bigint): string {
    return `${value / 1000n}.${(value % 1000n).toString().padStart(3, '0')}`;
  }

  private receiptCost(quantity: bigint, unitCost: string): string {
    const costCents = this.toDecimal(unitCost, 2);
    const totalCents = (quantity * costCents + 500n) / 1000n;
    return `${totalCents / 100n}.${(totalCents % 100n).toString().padStart(2, '0')}`;
  }

  private toDecimal(value: string, scale: number): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  }
}

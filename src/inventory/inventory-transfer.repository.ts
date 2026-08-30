import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateInventoryTransferDto } from './dto/create-inventory-transfer.dto';
import { ReceiveInventoryTransferDto } from './dto/receive-inventory-transfer.dto';
import {
  DuplicateInventoryTransferLineError,
  InvalidInventoryTransferTargetError,
  InventoryTransferIdempotencyConflictError,
  InventoryTransferInsufficientStockError,
  InventoryTransferNotFoundError,
  InventoryTransferStatusConflictError,
  InvalidInventoryTransferReceiptError,
  InventoryTransferDiscrepancyReasonRequiredError,
  InventoryTransferReceiptExceedsPendingError,
} from './inventory-transfer.errors';
import { applyInventoryValuation } from './inventory-valuation';
import { applyInventoryLotTracking } from './inventory-lot-tracking';
import { applyInventorySerialTracking } from './inventory-serial-tracking';
import {
  InventoryTransferData,
  InventoryTransferLineData,
  InventoryTransferReceiptData,
  InventoryTransferStatus,
} from './inventory-transfer.types';
import {
  normalizeProductQuantity,
  ProductBaseUnit,
  ProductQuantityPolicy,
  QuantityRoundingMode,
} from '../common/quantity-policy';

interface TransferHeaderRow {
  id: string;
  status: InventoryTransferStatus;
  reference: string;
  reason: string;
  creation_idempotency_key: string;
  request_fingerprint: string;
  dispatch_idempotency_key: string | null;
  created_at: Date;
  dispatched_at: Date | null;
  cancelled_at: Date | null;
  origin_warehouse_id: string;
  origin_warehouse_name: string;
  origin_branch_id: string;
  origin_branch_name: string;
  destination_warehouse_id: string;
  destination_warehouse_name: string;
  destination_branch_id: string;
  destination_branch_name: string;
  created_user_id: string;
  created_user_email: string;
  dispatched_user_id: string | null;
  dispatched_user_email: string | null;
  cancelled_user_id: string | null;
  cancelled_user_email: string | null;
}

interface TransferLineRow {
  id: string;
  line_number: number;
  product_id: string;
  product_name: string;
  product_sku: string;
  product_active: number | boolean;
  source_location_id: string;
  source_location_name: string;
  source_location_code: string;
  source_location_active: number | boolean;
  source_warehouse_id: string;
  destination_location_id: string;
  destination_location_name: string;
  destination_location_code: string;
  destination_location_active: number | boolean;
  destination_warehouse_id: string;
  quantity: string;
  received_quantity: string;
  discrepancy_quantity: string;
  serial_numbers: string | string[] | null;
}

interface ReceiptHeaderRow {
  id: string;
  discrepancy_reason: string | null;
  created_at: Date;
  received_user_id: string;
  received_user_email: string;
}

interface ReceiptLineRow {
  id: string;
  line_number: number;
  transfer_line_id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  received_quantity: string;
  discrepancy_quantity: string;
}

interface BalanceState {
  quantity: bigint;
  available: bigint;
  reserved: bigint;
  damaged: bigint;
  inTransit: bigint;
}

@Injectable()
export class InventoryTransferRepository {
  constructor(private readonly dataSource: DataSource) {}

  async list(
    tenantId: string,
    branchId: string,
  ): Promise<InventoryTransferData[]> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT t.id FROM inventory_transfers t
       INNER JOIN warehouses origin ON origin.id = t.origin_warehouse_id
         AND origin.tenant_id = t.tenant_id
       INNER JOIN warehouses destination ON destination.id = t.destination_warehouse_id
         AND destination.tenant_id = t.tenant_id
       WHERE t.tenant_id = ? AND (origin.branch_id = ? OR destination.branch_id = ?)
       ORDER BY t.created_at DESC, t.id DESC LIMIT 100`,
      [tenantId, branchId, branchId],
    );
    return Promise.all(
      rows.map(
        async ({ id }) =>
          (await this.findDocument(this.dataSource.manager, tenantId, id))!,
      ),
    );
  }

  findById(
    tenantId: string,
    id: string,
  ): Promise<InventoryTransferData | null> {
    return this.findDocument(this.dataSource.manager, tenantId, id);
  }

  async create(input: {
    tenantId: string;
    originWarehouseId: string;
    userId: string;
    idempotencyKey: string;
    dto: CreateInventoryTransferDto;
  }): Promise<{ transfer: InventoryTransferData; replay: boolean }> {
    if (input.originWarehouseId === input.dto.destinationWarehouseId) {
      throw new InvalidInventoryTransferTargetError();
    }
    this.assertDistinctLines(input.dto);
    const policies = await this.productQuantityPolicies(
      input.tenantId,
      input.dto.lines.map((line) => line.productId),
    );
    const normalizedLines = input.dto.lines.map((line) => {
      const policy = policies.get(line.productId);
      if (!policy) throw new InvalidInventoryTransferTargetError();
      return {
        ...line,
        quantity: normalizeProductQuantity(line.quantity, policy),
        serialNumbers: (line.serialNumbers ?? []).map((value) => value.trim()),
      };
    });
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          originWarehouseId: input.originWarehouseId,
          destinationWarehouseId: input.dto.destinationWarehouseId,
          reference: input.dto.reference,
          reason: input.dto.reason,
          lines: normalizedLines,
        }),
      )
      .digest('hex');

    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          await this.assertWarehouseAccess(
            manager,
            input.tenantId,
            input.userId,
            input.dto.destinationWarehouseId,
          );
          const replay = await this.findByCreationKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.fingerprint !== fingerprint)
              throw new InventoryTransferIdempotencyConflictError();
            return { transfer: replay.transfer, replay: true };
          }
          await this.assertWarehouses(
            manager,
            input.tenantId,
            input.originWarehouseId,
            input.dto.destinationWarehouseId,
          );
          for (const line of normalizedLines) {
            await this.assertLineTarget(
              manager,
              input.tenantId,
              input.originWarehouseId,
              input.dto.destinationWarehouseId,
              line.productId,
              line.sourceLocationId,
              line.destinationLocationId,
            );
          }
          const transferId = randomUUID();
          await manager.query(
            `INSERT INTO inventory_transfers
            (id, tenant_id, origin_warehouse_id, destination_warehouse_id,
             status, reference, reason, creation_idempotency_key,
             request_fingerprint, created_by_user_id)
           VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
            [
              transferId,
              input.tenantId,
              input.originWarehouseId,
              input.dto.destinationWarehouseId,
              input.dto.reference,
              input.dto.reason,
              input.idempotencyKey,
              fingerprint,
              input.userId,
            ],
          );
          for (const [index, line] of normalizedLines.entries()) {
            await manager.query(
              `INSERT INTO inventory_transfer_lines
              (id, tenant_id, transfer_id, line_number, product_id,
               source_location_id, destination_location_id, quantity, serial_numbers)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                transferId,
                index + 1,
                line.productId,
                line.sourceLocationId,
                line.destinationLocationId,
                line.quantity,
                JSON.stringify(line.serialNumbers),
              ],
            );
          }
          const transfer = await this.findDocument(
            manager,
            input.tenantId,
            transferId,
          );
          if (!transfer) throw new Error('CREATED_TRANSFER_NOT_FOUND');
          return { transfer, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByCreationKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay || replay.fingerprint !== fingerprint)
        throw new InventoryTransferIdempotencyConflictError();
      return { transfer: replay.transfer, replay: true };
    }
  }

  async dispatch(input: {
    tenantId: string;
    transferId: string;
    originWarehouseId: string;
    userId: string;
    idempotencyKey: string;
  }): Promise<{ transfer: InventoryTransferData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const [header] = await manager.query<
            Array<{
              status: InventoryTransferStatus;
              dispatch_idempotency_key: string | null;
              reference: string;
              reason: string;
              origin_warehouse_id: string;
              destination_warehouse_id: string;
            }>
          >(
            `SELECT status, dispatch_idempotency_key, reference, reason,
                  origin_warehouse_id, destination_warehouse_id
           FROM inventory_transfers
           WHERE id = ? AND tenant_id = ? AND origin_warehouse_id = ? FOR UPDATE`,
            [input.transferId, input.tenantId, input.originWarehouseId],
          );
          if (!header) throw new InventoryTransferNotFoundError();
          if (header.status === 'DISPATCHED') {
            if (header.dispatch_idempotency_key !== input.idempotencyKey)
              throw new InventoryTransferStatusConflictError();
            const replay = await this.findDocument(
              manager,
              input.tenantId,
              input.transferId,
            );
            if (!replay) throw new InventoryTransferNotFoundError();
            return { transfer: replay, replay: true };
          }
          if (header.status !== 'DRAFT')
            throw new InventoryTransferStatusConflictError();

          await this.assertWarehouses(
            manager,
            input.tenantId,
            header.origin_warehouse_id,
            header.destination_warehouse_id,
          );
          const lines = await this.findLineRows(
            manager,
            input.tenantId,
            input.transferId,
          );
          if (lines.length === 0) throw new InventoryTransferNotFoundError();
          for (const line of lines) {
            if (
              !line.product_active ||
              !line.source_location_active ||
              !line.destination_location_active ||
              line.source_warehouse_id !== header.origin_warehouse_id ||
              line.destination_warehouse_id !== header.destination_warehouse_id
            ) {
              throw new InvalidInventoryTransferTargetError();
            }
          }

          const balanceKeys = [
            ...new Set(
              lines.flatMap((line) => [
                `${line.product_id}:${line.source_location_id}`,
                `${line.product_id}:${line.destination_location_id}`,
              ]),
            ),
          ].sort();
          const balances = new Map<string, BalanceState>();
          for (const key of balanceKeys) {
            const separator = key.indexOf(':');
            const productId = key.slice(0, separator);
            const locationId = key.slice(separator + 1);
            await this.ensureBalance(
              manager,
              input.tenantId,
              productId,
              locationId,
            );
            const [row] = await manager.query<
              Array<{
                quantity: string;
                available_quantity: string;
                reserved_quantity: string;
                damaged_quantity: string;
                in_transit_quantity: string;
              }>
            >(
              `SELECT quantity, available_quantity, reserved_quantity,
                    damaged_quantity, in_transit_quantity
             FROM inventory_balances
             WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
              [input.tenantId, productId, locationId],
            );
            balances.set(key, {
              quantity: this.toUnits(row.quantity),
              available: this.toUnits(row.available_quantity),
              reserved: this.toUnits(row.reserved_quantity),
              damaged: this.toUnits(row.damaged_quantity),
              inTransit: this.toUnits(row.in_transit_quantity),
            });
          }

          for (const line of lines) {
            const quantity = this.toUnits(line.quantity);
            const sourceKey = `${line.product_id}:${line.source_location_id}`;
            const destinationKey = `${line.product_id}:${line.destination_location_id}`;
            const source = balances.get(sourceKey)!;
            const destination = balances.get(destinationKey)!;
            if (source.available < quantity)
              throw new InventoryTransferInsufficientStockError();
            source.available -= quantity;
            source.quantity -= quantity;
            destination.inTransit += quantity;
            destination.quantity += quantity;
            await this.updateBalance(
              manager,
              input.tenantId,
              line.product_id,
              line.source_location_id,
              source,
            );
            await this.updateBalance(
              manager,
              input.tenantId,
              line.product_id,
              line.destination_location_id,
              destination,
            );
            await this.insertMovement({
              manager,
              tenantId: input.tenantId,
              transferId: input.transferId,
              line,
              userId: input.userId,
              type: 'TRANSFER_OUT',
              locationId: line.source_location_id,
              quantityChange: this.fromUnits(-quantity),
              resultingQuantity: this.fromUnits(source.quantity),
              reason: header.reason,
              reference: header.reference,
            });
            await this.insertMovement({
              manager,
              tenantId: input.tenantId,
              transferId: input.transferId,
              line,
              userId: input.userId,
              type: 'TRANSFER_IN',
              locationId: line.destination_location_id,
              quantityChange: this.fromUnits(quantity),
              resultingQuantity: this.fromUnits(destination.quantity),
              reason: header.reason,
              reference: header.reference,
            });
          }
          await manager.query(
            `UPDATE inventory_transfers
           SET status = 'DISPATCHED', dispatch_idempotency_key = ?,
               dispatched_by_user_id = ?, dispatched_at = CURRENT_TIMESTAMP(6)
           WHERE id = ? AND tenant_id = ?`,
            [
              input.idempotencyKey,
              input.userId,
              input.transferId,
              input.tenantId,
            ],
          );
          const transfer = await this.findDocument(
            manager,
            input.tenantId,
            input.transferId,
          );
          if (!transfer) throw new InventoryTransferNotFoundError();
          return { transfer, replay: false };
        },
      );
    } catch (error) {
      if (this.isDuplicate(error))
        throw new InventoryTransferIdempotencyConflictError();
      throw error;
    }
  }

  async receive(input: {
    tenantId: string;
    transferId: string;
    destinationWarehouseId: string;
    userId: string;
    idempotencyKey: string;
    dto: ReceiveInventoryTransferDto;
  }): Promise<{ transfer: InventoryTransferData; replay: boolean }> {
    const lineIds = input.dto.lines.map(({ transferLineId }) => transferLineId);
    if (new Set(lineIds).size !== lineIds.length)
      throw new InvalidInventoryTransferReceiptError();
    const [target] = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM inventory_transfers
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [input.transferId, input.tenantId],
    );
    if (!target) throw new InventoryTransferNotFoundError();
    const policies = await this.transferLineQuantityPolicies(
      input.tenantId,
      input.transferId,
      lineIds,
    );
    const normalizedLines = input.dto.lines.map((line) => {
      const policy = policies.get(line.transferLineId);
      if (!policy) throw new InvalidInventoryTransferReceiptError();
      return {
        transferLineId: line.transferLineId,
        receivedQuantity: normalizeProductQuantity(
          line.receivedQuantity,
          policy,
          {
            enforceMinimum: false,
          },
        ),
        discrepancyQuantity: normalizeProductQuantity(
          line.discrepancyQuantity,
          policy,
          { enforceMinimum: false },
        ),
        receivedSerialNumbers: (line.receivedSerialNumbers ?? []).map((value) =>
          value.trim(),
        ),
        discrepancySerialNumbers: (line.discrepancySerialNumbers ?? []).map(
          (value) => value.trim(),
        ),
      };
    });
    if (
      normalizedLines.every(
        (line) =>
          this.toUnits(line.receivedQuantity) === 0n &&
          this.toUnits(line.discrepancyQuantity) === 0n,
      )
    ) {
      throw new InvalidInventoryTransferReceiptError();
    }
    const hasDiscrepancy = normalizedLines.some(
      (line) => this.toUnits(line.discrepancyQuantity) > 0n,
    );
    if (hasDiscrepancy && !input.dto.discrepancyReason) {
      throw new InventoryTransferDiscrepancyReasonRequiredError();
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          transferId: input.transferId,
          lines: [...normalizedLines].sort((left, right) =>
            left.transferLineId.localeCompare(right.transferLineId),
          ),
          discrepancyReason: input.dto.discrepancyReason ?? null,
        }),
      )
      .digest('hex');

    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findReceiptByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) {
            if (
              existing.transferId !== input.transferId ||
              existing.fingerprint !== fingerprint
            ) {
              throw new InventoryTransferIdempotencyConflictError();
            }
            const transfer = await this.findDocument(
              manager,
              input.tenantId,
              input.transferId,
            );
            if (
              !transfer ||
              transfer.destinationWarehouse.id !== input.destinationWarehouseId
            )
              throw new InventoryTransferNotFoundError();
            return { transfer, replay: true };
          }
          const [header] = await manager.query<
            Array<{
              status: InventoryTransferStatus;
              destination_warehouse_id: string;
              reference: string;
            }>
          >(
            `SELECT status, destination_warehouse_id, reference
             FROM inventory_transfers
             WHERE id = ? AND tenant_id = ? FOR UPDATE`,
            [input.transferId, input.tenantId],
          );
          if (!header) throw new InventoryTransferNotFoundError();
          if (header.destination_warehouse_id !== input.destinationWarehouseId)
            throw new InvalidInventoryTransferTargetError();
          if (!['DISPATCHED', 'PARTIALLY_RECEIVED'].includes(header.status))
            throw new InventoryTransferStatusConflictError();

          const transferLines = await this.findLineRows(
            manager,
            input.tenantId,
            input.transferId,
          );
          const transferLineMap = new Map(
            transferLines.map((line) => [line.id, line]),
          );
          const requested = normalizedLines.map((line) => {
            const transferLine = transferLineMap.get(line.transferLineId);
            if (!transferLine) throw new InvalidInventoryTransferReceiptError();
            const received = this.toUnits(line.receivedQuantity);
            const discrepancy = this.toUnits(line.discrepancyQuantity);
            const processed = received + discrepancy;
            if (processed <= 0n)
              throw new InvalidInventoryTransferReceiptError();
            const pending =
              this.toUnits(transferLine.quantity) -
              this.toUnits(transferLine.received_quantity) -
              this.toUnits(transferLine.discrepancy_quantity);
            if (processed > pending)
              throw new InventoryTransferReceiptExceedsPendingError();
            return {
              transferLine,
              received,
              discrepancy,
              receivedSerialNumbers: line.receivedSerialNumbers,
              discrepancySerialNumbers: line.discrepancySerialNumbers,
            };
          });

          const balanceKeys = [
            ...new Set(
              requested.map(
                ({ transferLine }) =>
                  `${transferLine.product_id}:${transferLine.destination_location_id}`,
              ),
            ),
          ].sort();
          const balances = new Map<string, BalanceState>();
          for (const key of balanceKeys) {
            const separator = key.indexOf(':');
            const productId = key.slice(0, separator);
            const locationId = key.slice(separator + 1);
            const [balance] = await manager.query<
              Array<{
                quantity: string;
                available_quantity: string;
                reserved_quantity: string;
                damaged_quantity: string;
                in_transit_quantity: string;
              }>
            >(
              `SELECT quantity, available_quantity, reserved_quantity,
                      damaged_quantity, in_transit_quantity
               FROM inventory_balances
               WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
              [input.tenantId, productId, locationId],
            );
            if (!balance) throw new InvalidInventoryTransferReceiptError();
            balances.set(key, {
              quantity: this.toUnits(balance.quantity),
              available: this.toUnits(balance.available_quantity),
              reserved: this.toUnits(balance.reserved_quantity),
              damaged: this.toUnits(balance.damaged_quantity),
              inTransit: this.toUnits(balance.in_transit_quantity),
            });
          }

          const receiptId = randomUUID();
          await manager.query(
            `INSERT INTO inventory_transfer_receipts
              (id, tenant_id, transfer_id, discrepancy_reason, idempotency_key,
               request_fingerprint, received_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              receiptId,
              input.tenantId,
              input.transferId,
              input.dto.discrepancyReason ?? null,
              input.idempotencyKey,
              fingerprint,
              input.userId,
            ],
          );
          for (const [index, item] of requested.entries()) {
            const line = item.transferLine;
            const processed = item.received + item.discrepancy;
            const balanceKey = `${line.product_id}:${line.destination_location_id}`;
            const balance = balances.get(balanceKey)!;
            if (balance.inTransit < processed)
              throw new InvalidInventoryTransferReceiptError();
            balance.inTransit -= processed;
            balance.available += item.received;
            balance.quantity -= item.discrepancy;
            await this.updateBalance(
              manager,
              input.tenantId,
              line.product_id,
              line.destination_location_id,
              balance,
            );
            await manager.query(
              `UPDATE inventory_transfer_lines
               SET received_quantity = received_quantity + ?,
                   discrepancy_quantity = discrepancy_quantity + ?
               WHERE id = ? AND tenant_id = ?`,
              [
                this.fromUnits(item.received),
                this.fromUnits(item.discrepancy),
                line.id,
                input.tenantId,
              ],
            );
            const receiptLineId = randomUUID();
            await manager.query(
              `INSERT INTO inventory_transfer_receipt_lines
                (id, tenant_id, receipt_id, transfer_line_id, line_number,
                 received_quantity, discrepancy_quantity)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                receiptLineId,
                input.tenantId,
                receiptId,
                line.id,
                index + 1,
                this.fromUnits(item.received),
                this.fromUnits(item.discrepancy),
              ],
            );
            if (item.received > 0n) {
              await this.insertReceiptMovement({
                manager,
                tenantId: input.tenantId,
                transferId: input.transferId,
                transferLine: line,
                receiptId,
                receiptLineId,
                userId: input.userId,
                type: 'TRANSFER_RECEIPT',
                quantity: item.received,
                resultingQuantity: balance.quantity,
                reason: `Recepción ${header.reference}`,
                reference: header.reference,
                serialNumbers: item.receivedSerialNumbers,
              });
            }
            if (item.discrepancy > 0n) {
              await this.insertReceiptMovement({
                manager,
                tenantId: input.tenantId,
                transferId: input.transferId,
                transferLine: line,
                receiptId,
                receiptLineId,
                userId: input.userId,
                type: 'TRANSFER_DISCREPANCY',
                quantity: item.discrepancy,
                resultingQuantity: balance.quantity,
                reason: input.dto.discrepancyReason!,
                reference: header.reference,
                serialNumbers: item.discrepancySerialNumbers,
              });
            }
          }
          const [progress] = await manager.query<
            Array<{ pending: number | string }>
          >(
            `SELECT COUNT(*) AS pending FROM inventory_transfer_lines
             WHERE tenant_id = ? AND transfer_id = ?
               AND received_quantity + discrepancy_quantity < quantity`,
            [input.tenantId, input.transferId],
          );
          const status =
            Number(progress.pending) === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
          await manager.query(
            'UPDATE inventory_transfers SET status = ? WHERE id = ? AND tenant_id = ?',
            [status, input.transferId, input.tenantId],
          );
          const transfer = await this.findDocument(
            manager,
            input.tenantId,
            input.transferId,
          );
          if (!transfer) throw new InventoryTransferNotFoundError();
          return { transfer, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findReceiptByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (
        !existing ||
        existing.transferId !== input.transferId ||
        existing.fingerprint !== fingerprint
      ) {
        throw new InventoryTransferIdempotencyConflictError();
      }
      const transfer = await this.findDocument(
        this.dataSource.manager,
        input.tenantId,
        input.transferId,
      );
      if (!transfer) throw new InventoryTransferNotFoundError();
      return { transfer, replay: true };
    }
  }

  async cancel(
    tenantId: string,
    transferId: string,
    originWarehouseId: string,
    userId: string,
  ): Promise<InventoryTransferData> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [header] = await manager.query<
        Array<{ status: InventoryTransferStatus }>
      >(
        `SELECT status FROM inventory_transfers
         WHERE id = ? AND tenant_id = ? AND origin_warehouse_id = ? FOR UPDATE`,
        [transferId, tenantId, originWarehouseId],
      );
      if (!header) throw new InventoryTransferNotFoundError();
      if (header.status === 'DISPATCHED')
        throw new InventoryTransferStatusConflictError();
      if (header.status === 'DRAFT') {
        await manager.query(
          `UPDATE inventory_transfers
           SET status = 'CANCELLED', cancelled_by_user_id = ?,
               cancelled_at = CURRENT_TIMESTAMP(6)
           WHERE id = ? AND tenant_id = ?`,
          [userId, transferId, tenantId],
        );
      }
      const transfer = await this.findDocument(manager, tenantId, transferId);
      if (!transfer) throw new InventoryTransferNotFoundError();
      return transfer;
    });
  }

  private async findByCreationKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ): Promise<{ transfer: InventoryTransferData; fingerprint: string } | null> {
    const [row] = await manager.query<
      Array<{ id: string; request_fingerprint: string }>
    >(
      `SELECT id, request_fingerprint FROM inventory_transfers
       WHERE tenant_id = ? AND creation_idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    if (!row) return null;
    const transfer = await this.findDocument(manager, tenantId, row.id);
    return transfer ? { transfer, fingerprint: row.request_fingerprint } : null;
  }

  private async findReceiptByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ): Promise<{ transferId: string; fingerprint: string } | null> {
    const [row] = await manager.query<
      Array<{ transfer_id: string; request_fingerprint: string }>
    >(
      `SELECT transfer_id, request_fingerprint
       FROM inventory_transfer_receipts
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    return row
      ? { transferId: row.transfer_id, fingerprint: row.request_fingerprint }
      : null;
  }

  private async findDocument(
    manager: EntityManager,
    tenantId: string,
    transferId: string,
  ): Promise<InventoryTransferData | null> {
    const [header] = await manager.query<TransferHeaderRow[]>(
      `SELECT t.id, t.status, t.reference, t.reason, t.creation_idempotency_key,
              t.request_fingerprint, t.dispatch_idempotency_key,
              t.created_at, t.dispatched_at, t.cancelled_at,
              ow.id AS origin_warehouse_id, ow.name AS origin_warehouse_name,
              ob.id AS origin_branch_id, ob.name AS origin_branch_name,
              dw.id AS destination_warehouse_id, dw.name AS destination_warehouse_name,
              db.id AS destination_branch_id, db.name AS destination_branch_name,
              cu.id AS created_user_id, cu.email AS created_user_email,
              du.id AS dispatched_user_id, du.email AS dispatched_user_email,
              xu.id AS cancelled_user_id, xu.email AS cancelled_user_email
       FROM inventory_transfers t
       INNER JOIN warehouses ow ON ow.id = t.origin_warehouse_id AND ow.tenant_id = t.tenant_id
       INNER JOIN branches ob ON ob.id = ow.branch_id AND ob.tenant_id = t.tenant_id
       INNER JOIN warehouses dw ON dw.id = t.destination_warehouse_id AND dw.tenant_id = t.tenant_id
       INNER JOIN branches db ON db.id = dw.branch_id AND db.tenant_id = t.tenant_id
       INNER JOIN users cu ON cu.id = t.created_by_user_id
       LEFT JOIN users du ON du.id = t.dispatched_by_user_id
       LEFT JOIN users xu ON xu.id = t.cancelled_by_user_id
       WHERE t.id = ? AND t.tenant_id = ? LIMIT 1`,
      [transferId, tenantId],
    );
    if (!header) return null;
    const lines = await this.findLineRows(manager, tenantId, transferId);
    const receipts = await this.findReceipts(manager, tenantId, transferId);
    return {
      id: header.id,
      status: header.status,
      reference: header.reference,
      reason: header.reason,
      originWarehouse: {
        id: header.origin_warehouse_id,
        name: header.origin_warehouse_name,
        branch: {
          id: header.origin_branch_id,
          name: header.origin_branch_name,
        },
      },
      destinationWarehouse: {
        id: header.destination_warehouse_id,
        name: header.destination_warehouse_name,
        branch: {
          id: header.destination_branch_id,
          name: header.destination_branch_name,
        },
      },
      lines: lines.map((line) => this.toLine(line)),
      receipts,
      createdBy: {
        id: header.created_user_id,
        email: header.created_user_email,
      },
      dispatchedBy:
        header.dispatched_user_id && header.dispatched_user_email
          ? {
              id: header.dispatched_user_id,
              email: header.dispatched_user_email,
            }
          : null,
      cancelledBy:
        header.cancelled_user_id && header.cancelled_user_email
          ? { id: header.cancelled_user_id, email: header.cancelled_user_email }
          : null,
      createdAt: new Date(header.created_at).toISOString(),
      dispatchedAt: header.dispatched_at
        ? new Date(header.dispatched_at).toISOString()
        : null,
      cancelledAt: header.cancelled_at
        ? new Date(header.cancelled_at).toISOString()
        : null,
    };
  }

  private findLineRows(
    manager: EntityManager,
    tenantId: string,
    transferId: string,
  ): Promise<TransferLineRow[]> {
    return manager.query<TransferLineRow[]>(
      `SELECT tl.id, tl.line_number, tl.quantity, tl.serial_numbers,
              tl.received_quantity, tl.discrepancy_quantity,
              p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              p.active AS product_active,
              sl.id AS source_location_id, sl.name AS source_location_name,
              sl.code AS source_location_code, sl.active AS source_location_active,
              sl.warehouse_id AS source_warehouse_id,
              dl.id AS destination_location_id, dl.name AS destination_location_name,
              dl.code AS destination_location_code, dl.active AS destination_location_active,
              dl.warehouse_id AS destination_warehouse_id
       FROM inventory_transfer_lines tl
       INNER JOIN products p ON p.id = tl.product_id AND p.tenant_id = tl.tenant_id
       INNER JOIN locations sl ON sl.id = tl.source_location_id AND sl.tenant_id = tl.tenant_id
       INNER JOIN locations dl ON dl.id = tl.destination_location_id AND dl.tenant_id = tl.tenant_id
       WHERE tl.tenant_id = ? AND tl.transfer_id = ?
       ORDER BY tl.line_number, tl.id`,
      [tenantId, transferId],
    );
  }

  private async findReceipts(
    manager: EntityManager,
    tenantId: string,
    transferId: string,
  ): Promise<InventoryTransferReceiptData[]> {
    const headers = await manager.query<ReceiptHeaderRow[]>(
      `SELECT r.id, r.discrepancy_reason, r.created_at,
              u.id AS received_user_id, u.email AS received_user_email
       FROM inventory_transfer_receipts r
       INNER JOIN users u ON u.id = r.received_by_user_id AND u.tenant_id = r.tenant_id
       WHERE r.tenant_id = ? AND r.transfer_id = ?
       ORDER BY r.created_at, r.id`,
      [tenantId, transferId],
    );
    return Promise.all(
      headers.map(async (header) => {
        const lines = await manager.query<ReceiptLineRow[]>(
          `SELECT rl.id, rl.line_number, rl.transfer_line_id,
                  p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
                  rl.received_quantity, rl.discrepancy_quantity
           FROM inventory_transfer_receipt_lines rl
           INNER JOIN inventory_transfer_lines tl
             ON tl.id = rl.transfer_line_id AND tl.tenant_id = rl.tenant_id
           INNER JOIN products p ON p.id = tl.product_id AND p.tenant_id = rl.tenant_id
           WHERE rl.tenant_id = ? AND rl.receipt_id = ?
           ORDER BY rl.line_number, rl.id`,
          [tenantId, header.id],
        );
        return {
          id: header.id,
          discrepancyReason: header.discrepancy_reason,
          receivedBy: {
            id: header.received_user_id,
            email: header.received_user_email,
          },
          createdAt: new Date(header.created_at).toISOString(),
          lines: lines.map((line) => ({
            id: line.id,
            lineNumber: Number(line.line_number),
            transferLineId: line.transfer_line_id,
            product: {
              id: line.product_id,
              name: line.product_name,
              sku: line.product_sku,
            },
            receivedQuantity: this.fromUnits(
              this.toUnits(line.received_quantity),
            ),
            discrepancyQuantity: this.fromUnits(
              this.toUnits(line.discrepancy_quantity),
            ),
          })),
        };
      }),
    );
  }

  private async assertWarehouses(
    manager: EntityManager,
    tenantId: string,
    originWarehouseId: string,
    destinationWarehouseId: string,
  ): Promise<void> {
    const [row] = await manager.query<
      Array<{ origin_id: string; destination_id: string }>
    >(
      `SELECT origin.id AS origin_id, destination.id AS destination_id
       FROM warehouses origin
       INNER JOIN warehouses destination ON destination.id = ?
         AND destination.tenant_id = origin.tenant_id AND destination.active = TRUE
       WHERE origin.id = ? AND origin.tenant_id = ? AND origin.active = TRUE
         AND origin.id <> destination.id LIMIT 1`,
      [destinationWarehouseId, originWarehouseId, tenantId],
    );
    if (!row) throw new InvalidInventoryTransferTargetError();
  }

  private async assertWarehouseAccess(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    warehouseId: string,
  ): Promise<void> {
    const [row] = await manager.query<Array<{ id: string }>>(
      `SELECT w.id FROM warehouses w
       WHERE w.id = ? AND w.tenant_id = ? AND w.active = TRUE
         AND (
           EXISTS (
             SELECT 1 FROM user_roles ur
             INNER JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
             WHERE ur.user_id = ? AND ur.tenant_id = ? AND r.code = 'ADMIN'
           )
           OR EXISTS (
             SELECT 1 FROM user_branch_access uba
             WHERE uba.user_id = ? AND uba.tenant_id = ? AND uba.branch_id = w.branch_id
           )
         )
       LIMIT 1`,
      [warehouseId, tenantId, userId, tenantId, userId, tenantId],
    );
    if (!row) throw new InvalidInventoryTransferTargetError();
  }

  private async assertLineTarget(
    manager: EntityManager,
    tenantId: string,
    originWarehouseId: string,
    destinationWarehouseId: string,
    productId: string,
    sourceLocationId: string,
    destinationLocationId: string,
  ): Promise<void> {
    const [row] = await manager.query<Array<{ product_id: string }>>(
      `SELECT p.id AS product_id FROM products p
       INNER JOIN locations source ON source.id = ? AND source.tenant_id = p.tenant_id
         AND source.warehouse_id = ? AND source.active = TRUE
       INNER JOIN locations destination ON destination.id = ?
         AND destination.tenant_id = p.tenant_id
         AND destination.warehouse_id = ? AND destination.active = TRUE
       WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE
         AND p.variant_schema IS NULL LIMIT 1`,
      [
        sourceLocationId,
        originWarehouseId,
        destinationLocationId,
        destinationWarehouseId,
        productId,
        tenantId,
      ],
    );
    if (!row) throw new InvalidInventoryTransferTargetError();
  }

  private assertDistinctLines(dto: CreateInventoryTransferDto): void {
    const keys = dto.lines.map(
      (line) =>
        `${line.productId}:${line.sourceLocationId}:${line.destinationLocationId}`,
    );
    if (new Set(keys).size !== keys.length)
      throw new DuplicateInventoryTransferLineError();
  }

  private async ensureBalance(
    manager: EntityManager,
    tenantId: string,
    productId: string,
    locationId: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity)
       VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE quantity = quantity`,
      [tenantId, productId, locationId],
    );
  }

  private async updateBalance(
    manager: EntityManager,
    tenantId: string,
    productId: string,
    locationId: string,
    balance: BalanceState,
  ): Promise<void> {
    await manager.query(
      `UPDATE inventory_balances
       SET quantity = ?, available_quantity = ?, reserved_quantity = ?,
           damaged_quantity = ?, in_transit_quantity = ?
       WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
      [
        this.fromUnits(balance.quantity),
        this.fromUnits(balance.available),
        this.fromUnits(balance.reserved),
        this.fromUnits(balance.damaged),
        this.fromUnits(balance.inTransit),
        tenantId,
        productId,
        locationId,
      ],
    );
  }

  private async insertMovement(input: {
    manager: EntityManager;
    tenantId: string;
    transferId: string;
    line: TransferLineRow;
    userId: string;
    type: 'TRANSFER_OUT' | 'TRANSFER_IN';
    locationId: string;
    quantityChange: string;
    resultingQuantity: string;
    reason: string;
    reference: string;
    serialNumbers?: string[];
  }): Promise<void> {
    const movementKey = `transfer:${input.transferId}:${input.line.line_number}:${input.type}`;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          transferId: input.transferId,
          transferLineId: input.line.id,
          type: input.type,
          locationId: input.locationId,
          quantityChange: input.quantityChange,
        }),
      )
      .digest('hex');
    const movementId = randomUUID();
    await input.manager.query(
      `INSERT INTO inventory_movements
        (id, tenant_id, product_id, location_id, type, quantity_change,
         resulting_quantity, reason, reference, idempotency_key,
         request_fingerprint, created_by_user_id, transfer_id, transfer_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        movementId,
        input.tenantId,
        input.line.product_id,
        input.locationId,
        input.type,
        input.quantityChange,
        input.resultingQuantity,
        input.reason,
        input.reference,
        movementKey,
        fingerprint,
        input.userId,
        input.transferId,
        input.line.id,
      ],
    );
    await applyInventoryValuation(input.manager, movementId);
    await applyInventoryLotTracking(input.manager, movementId);
    await applyInventorySerialTracking(input.manager, movementId, {
      serialNumbers:
        input.type === 'TRANSFER_OUT'
          ? this.serialNumbers(input.line.serial_numbers)
          : undefined,
      destinationLocationId: input.line.destination_location_id,
    });
  }

  private async insertReceiptMovement(input: {
    manager: EntityManager;
    tenantId: string;
    transferId: string;
    transferLine: TransferLineRow;
    receiptId: string;
    receiptLineId: string;
    userId: string;
    type: 'TRANSFER_RECEIPT' | 'TRANSFER_DISCREPANCY';
    quantity: bigint;
    resultingQuantity: bigint;
    reason: string;
    reference: string;
    serialNumbers?: string[];
  }): Promise<void> {
    const movementKey = `receipt:${input.receiptId}:${input.transferLine.line_number}:${input.type}`;
    const isReceipt = input.type === 'TRANSFER_RECEIPT';
    const quantityChange = isReceipt
      ? '0.000'
      : this.fromUnits(-input.quantity);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          receiptId: input.receiptId,
          receiptLineId: input.receiptLineId,
          type: input.type,
          quantity: this.fromUnits(input.quantity),
        }),
      )
      .digest('hex');
    const movementId = randomUUID();
    await input.manager.query(
      `INSERT INTO inventory_movements
        (id, tenant_id, product_id, location_id, type, from_state, to_state,
         state_quantity, quantity_change, resulting_quantity, reason, reference,
         idempotency_key, request_fingerprint, created_by_user_id,
         transfer_id, transfer_line_id, receipt_id, receipt_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        movementId,
        input.tenantId,
        input.transferLine.product_id,
        input.transferLine.destination_location_id,
        input.type,
        isReceipt ? 'IN_TRANSIT' : null,
        isReceipt ? 'AVAILABLE' : null,
        isReceipt ? this.fromUnits(input.quantity) : null,
        quantityChange,
        this.fromUnits(input.resultingQuantity),
        input.reason,
        input.reference,
        movementKey,
        fingerprint,
        input.userId,
        input.transferId,
        input.transferLine.id,
        input.receiptId,
        input.receiptLineId,
      ],
    );
    await applyInventoryValuation(input.manager, movementId);
    await applyInventoryLotTracking(input.manager, movementId);
    await applyInventorySerialTracking(input.manager, movementId, {
      serialNumbers: input.serialNumbers,
    });
  }

  private toLine(line: TransferLineRow): InventoryTransferLineData {
    const received = this.toUnits(line.received_quantity);
    const discrepancy = this.toUnits(line.discrepancy_quantity);
    const pending = this.toUnits(line.quantity) - received - discrepancy;
    return {
      id: line.id,
      lineNumber: Number(line.line_number),
      product: {
        id: line.product_id,
        name: line.product_name,
        sku: line.product_sku,
      },
      sourceLocation: {
        id: line.source_location_id,
        name: line.source_location_name,
        code: line.source_location_code,
      },
      destinationLocation: {
        id: line.destination_location_id,
        name: line.destination_location_name,
        code: line.destination_location_code,
      },
      quantity: this.fromUnits(this.toUnits(line.quantity)),
      receivedQuantity: this.fromUnits(received),
      discrepancyQuantity: this.fromUnits(discrepancy),
      pendingQuantity: this.fromUnits(pending),
      serialNumbers: this.serialNumbers(line.serial_numbers),
    };
  }

  private serialNumbers(value: string | string[] | null): string[] {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private async productQuantityPolicies(
    tenantId: string,
    productIds: string[],
  ): Promise<Map<string, ProductQuantityPolicy>> {
    const uniqueIds = [...new Set(productIds)];
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        base_unit: ProductBaseUnit;
        quantity_precision: number;
        quantity_rounding: QuantityRoundingMode;
        minimum_quantity: string;
      }>
    >(
      `SELECT id, base_unit, quantity_precision, quantity_rounding, minimum_quantity
       FROM products WHERE tenant_id = ? AND active = TRUE
         AND id IN (${uniqueIds.map(() => '?').join(',')})`,
      [tenantId, ...uniqueIds],
    );
    return this.policyMap(rows.map((row) => ({ ...row, key: row.id })));
  }

  private async transferLineQuantityPolicies(
    tenantId: string,
    transferId: string,
    lineIds: string[],
  ): Promise<Map<string, ProductQuantityPolicy>> {
    const rows = await this.dataSource.query<
      Array<{
        key: string;
        base_unit: ProductBaseUnit;
        quantity_precision: number;
        quantity_rounding: QuantityRoundingMode;
        minimum_quantity: string;
      }>
    >(
      `SELECT tl.id AS \`key\`, p.base_unit, p.quantity_precision,
              p.quantity_rounding, p.minimum_quantity
       FROM inventory_transfer_lines tl
       INNER JOIN products p ON p.id = tl.product_id AND p.tenant_id = tl.tenant_id
       WHERE tl.tenant_id = ? AND tl.transfer_id = ?
         AND tl.id IN (${lineIds.map(() => '?').join(',')})`,
      [tenantId, transferId, ...lineIds],
    );
    return this.policyMap(rows);
  }

  private policyMap(
    rows: Array<{
      key: string;
      base_unit: ProductBaseUnit;
      quantity_precision: number;
      quantity_rounding: QuantityRoundingMode;
      minimum_quantity: string;
    }>,
  ): Map<string, ProductQuantityPolicy> {
    return new Map(
      rows.map((row) => [
        row.key,
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
    const [integerPart, fractionPart = ''] = value.split('.');
    return (
      BigInt(integerPart) * 1000n + BigInt(`${fractionPart}000`.slice(0, 3))
    );
  }

  private fromUnits(units: bigint): string {
    const sign = units < 0n ? '-' : '';
    const absolute = units < 0n ? -units : units;
    return `${sign}${absolute / 1000n}.${(absolute % 1000n).toString().padStart(3, '0')}`;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}

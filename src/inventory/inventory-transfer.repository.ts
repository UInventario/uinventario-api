import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateInventoryTransferDto } from './dto/create-inventory-transfer.dto';
import {
  DuplicateInventoryTransferLineError,
  InvalidInventoryTransferTargetError,
  InventoryTransferIdempotencyConflictError,
  InventoryTransferInsufficientStockError,
  InventoryTransferNotFoundError,
  InventoryTransferStatusConflictError,
} from './inventory-transfer.errors';
import {
  InventoryTransferData,
  InventoryTransferLineData,
  InventoryTransferStatus,
} from './inventory-transfer.types';

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

  async list(tenantId: string): Promise<InventoryTransferData[]> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM inventory_transfers
       WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
      [tenantId],
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
    const normalizedLines = input.dto.lines.map((line) => ({
      ...line,
      quantity: this.fromUnits(this.toUnits(line.quantity)),
    }));
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
               source_location_id, destination_location_id, quantity)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                transferId,
                index + 1,
                line.productId,
                line.sourceLocationId,
                line.destinationLocationId,
                line.quantity,
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
           WHERE id = ? AND tenant_id = ? FOR UPDATE`,
            [input.transferId, input.tenantId],
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

  async cancel(
    tenantId: string,
    transferId: string,
    userId: string,
  ): Promise<InventoryTransferData> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [header] = await manager.query<
        Array<{ status: InventoryTransferStatus }>
      >(
        `SELECT status FROM inventory_transfers
         WHERE id = ? AND tenant_id = ? FOR UPDATE`,
        [transferId, tenantId],
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
      `SELECT tl.id, tl.line_number, tl.quantity,
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
       WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE LIMIT 1`,
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
    await input.manager.query(
      `INSERT INTO inventory_movements
        (id, tenant_id, product_id, location_id, type, quantity_change,
         resulting_quantity, reason, reference, idempotency_key,
         request_fingerprint, created_by_user_id, transfer_id, transfer_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
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
  }

  private toLine(line: TransferLineRow): InventoryTransferLineData {
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
    };
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

import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { CreateInventoryStateTransitionDto } from './dto/create-inventory-state-transition.dto';
import { ListInventoryStockDto } from './dto/list-inventory-stock.dto';
import { ListInventoryMovementsDto } from './dto/list-inventory-movements.dto';
import {
  IdempotencyConflictError,
  InitialStockAlreadyExistsError,
  InsufficientStockError,
  InsufficientStockStateError,
  InvalidStockStateTransitionError,
  InventoryTargetNotFoundError,
  MovementReferenceRequiredError,
} from './inventory.errors';
import {
  InventoryBalanceData,
  InventoryLocationData,
  InventoryMovementType,
  InventoryStockState,
  InventoryMovementHistoryItem,
  InventoryMovementData,
  InventoryStockItem,
} from './inventory.types';

interface MovementRow {
  id: string;
  type: InventoryMovementType;
  quantity_change: string;
  resulting_quantity: string;
  reason: string;
  reference: string | null;
  request_fingerprint: string;
  created_at: Date | string;
  product_id: string;
  product_name: string;
  product_sku: string;
  location_id: string;
  location_name: string;
  location_code: string;
  from_state: InventoryStockState | null;
  to_state: InventoryStockState | null;
  state_quantity: string | null;
}

@Injectable()
export class InventoryRepository {
  constructor(private readonly dataSource: DataSource) {}

  async listLocations(
    tenantId: string,
    warehouseId: string,
  ): Promise<InventoryLocationData[]> {
    return this.dataSource.query<InventoryLocationData[]>(
      `SELECT id, name, code FROM locations
       WHERE tenant_id = ? AND warehouse_id = ? AND active = TRUE ORDER BY name, id`,
      [tenantId, warehouseId],
    );
  }

  async listMovements(
    tenantId: string,
    branchId: string,
    query: ListInventoryMovementsDto,
  ): Promise<{
    items: InventoryMovementHistoryItem[];
    total: number;
    scope: { branch: { id: string; name: string } };
  }> {
    const [branch] = await this.dataSource.query<
      Array<{ id: string; name: string }>
    >(
      'SELECT id, name FROM branches WHERE id = ? AND tenant_id = ? AND active = TRUE LIMIT 1',
      [branchId, tenantId],
    );
    if (!branch) throw new InventoryTargetNotFoundError();

    const filters = ['im.tenant_id = ?', 'b.id = ?'];
    const parameters: unknown[] = [tenantId, branchId];
    if (query.productId) {
      filters.push('im.product_id = ?');
      parameters.push(query.productId);
    }
    if (query.locationId) {
      filters.push('im.location_id = ?');
      parameters.push(query.locationId);
    }
    if (query.userId) {
      filters.push('im.created_by_user_id = ?');
      parameters.push(query.userId);
    }
    if (query.q) {
      const search = `%${query.q}%`;
      filters.push(
        '(p.name LIKE ? OR p.normalized_sku LIKE ? OR p.barcode LIKE ?)',
      );
      parameters.push(search, search.toUpperCase(), search);
    }
    if (query.location) {
      const search = `%${query.location}%`;
      filters.push('(l.name LIKE ? OR l.code LIKE ? OR w.name LIKE ?)');
      parameters.push(search, search, search);
    }
    if (query.responsible) {
      filters.push('u.email LIKE ?');
      parameters.push(`%${query.responsible}%`);
    }
    if (query.document) {
      const search = `%${query.document}%`;
      filters.push(`(
        im.reference LIKE ? OR im.idempotency_key LIKE ? OR im.id LIKE ?
        OR im.sale_id LIKE ? OR im.transfer_id LIKE ? OR im.receipt_id LIKE ?
      )`);
      parameters.push(search, search, search, search, search, search);
    }
    if (query.type) {
      filters.push('im.type = ?');
      parameters.push(query.type);
    }
    if (query.dateFrom) {
      filters.push('im.created_at >= ?');
      parameters.push(query.dateFrom);
    }
    if (query.dateTo) {
      filters.push('im.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      parameters.push(query.dateTo);
    }
    const joins = `FROM inventory_movements im
      INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
      INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
      INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = im.tenant_id
      INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = im.tenant_id
      INNER JOIN users u ON u.id = im.created_by_user_id AND u.tenant_id = im.tenant_id`;
    const where = filters.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<
        Array<{
          id: string;
          type: InventoryMovementHistoryItem['type'];
          quantity_change: string;
          resulting_quantity: string;
          idempotency_key: string;
          sale_id: string | null;
          transfer_id: string | null;
          receipt_id: string | null;
          reason: string;
          reference: string | null;
          created_at: Date | string;
          product_id: string;
          product_name: string;
          product_sku: string;
          location_id: string;
          location_name: string;
          location_code: string;
          warehouse_id: string;
          warehouse_name: string;
          user_id: string;
          user_email: string;
          from_state: InventoryStockState | null;
          to_state: InventoryStockState | null;
          state_quantity: string | null;
        }>
      >(
        `SELECT im.id, im.type, im.quantity_change, im.resulting_quantity,
                im.idempotency_key, im.sale_id, im.transfer_id, im.receipt_id,
                im.from_state, im.to_state, im.state_quantity,
                im.reason, im.reference, im.created_at,
                p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
                l.id AS location_id, l.name AS location_name, l.code AS location_code,
                w.id AS warehouse_id, w.name AS warehouse_name,
                u.id AS user_id, u.email AS user_email
         ${joins} WHERE ${where}
         ORDER BY im.created_at DESC, im.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total ${joins} WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        direction:
          row.from_state && row.to_state
            ? 'TRANSFER'
            : row.quantity_change.startsWith('-')
              ? 'OUT'
              : 'IN',
        quantityChange: this.normalizeDecimal(row.quantity_change),
        previousQuantity: this.fromUnits(
          this.toUnits(row.resulting_quantity) -
            this.toUnits(row.quantity_change),
        ),
        resultingQuantity: this.normalizeDecimal(row.resulting_quantity),
        reason: row.reason,
        reference: row.reference,
        createdAt: new Date(row.created_at).toISOString(),
        product: {
          id: row.product_id,
          name: row.product_name,
          sku: row.product_sku,
        },
        location: {
          id: row.location_id,
          name: row.location_name,
          code: row.location_code,
          warehouse: { id: row.warehouse_id, name: row.warehouse_name },
        },
        responsible: { id: row.user_id, email: row.user_email },
        correlationId: row.sale_id ?? row.transfer_id ?? row.id,
        idempotencyKey: row.idempotency_key,
        document: row.receipt_id
          ? { type: 'RECEIPT', id: row.receipt_id, reference: row.reference }
          : row.transfer_id
            ? {
                type: 'TRANSFER',
                id: row.transfer_id,
                reference: row.reference,
              }
            : row.sale_id
              ? { type: 'SALE', id: row.sale_id, reference: row.reference }
              : { type: 'MOVEMENT', id: row.id, reference: row.reference },
        stateTransition:
          row.from_state && row.to_state && row.state_quantity
            ? {
                from: row.from_state,
                to: row.to_state,
                quantity: this.normalizeDecimal(row.state_quantity),
              }
            : null,
      })),
      total: Number(countRows[0]?.total ?? 0),
      scope: { branch },
    };
  }

  async listStock(
    tenantId: string,
    branchId: string,
    warehouseId: string,
    query: ListInventoryStockDto,
  ): Promise<{
    items: InventoryStockItem[];
    total: number;
    scope: {
      branch: { id: string; name: string };
      warehouse: { id: string; name: string };
    };
  }> {
    const scopeRows = await this.dataSource.query<
      Array<{
        branch_id: string;
        branch_name: string;
        warehouse_id: string;
        warehouse_name: string;
      }>
    >(
      `SELECT b.id AS branch_id, b.name AS branch_name,
              w.id AS warehouse_id, w.name AS warehouse_name
       FROM branches b
       INNER JOIN warehouses w ON w.branch_id = b.id AND w.tenant_id = b.tenant_id
       WHERE b.id = ? AND w.id = ? AND b.tenant_id = ?
         AND b.active = TRUE AND w.active = TRUE LIMIT 1`,
      [branchId, warehouseId, tenantId],
    );
    const scope = scopeRows[0];
    if (!scope) throw new InventoryTargetNotFoundError();

    const filters = ['p.tenant_id = ?'];
    const parameters: unknown[] = [tenantId];
    if (query.productId) {
      filters.push('p.id = ?');
      parameters.push(query.productId);
    }
    if (query.q) {
      const search = `%${query.q}%`;
      filters.push(
        '(p.name LIKE ? OR p.normalized_sku LIKE ? OR p.barcode LIKE ?)',
      );
      parameters.push(search, search.toUpperCase(), search);
    }
    const where = filters.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<
        Array<{
          product_id: string;
          product_name: string;
          product_sku: string;
          active: number | boolean;
          available_quantity: string;
          reserved_quantity: string;
          damaged_quantity: string;
          in_transit_quantity: string;
          total_quantity: string;
        }>
      >(
        `SELECT p.id AS product_id, p.name AS product_name, p.sku AS product_sku, p.active,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.available_quantity ELSE 0 END), 0) AS available_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.reserved_quantity ELSE 0 END), 0) AS reserved_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.damaged_quantity ELSE 0 END), 0) AS damaged_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.in_transit_quantity ELSE 0 END), 0) AS in_transit_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.quantity ELSE 0 END), 0) AS total_quantity
         FROM products p
         LEFT JOIN inventory_balances ib ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
         LEFT JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         WHERE ${where}
         GROUP BY p.id, p.name, p.sku, p.active, p.created_at
         ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
        [
          warehouseId,
          warehouseId,
          warehouseId,
          warehouseId,
          warehouseId,
          ...parameters,
          query.pageSize,
          offset,
        ],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM products p WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      items: rows.map((row) => {
        const available = this.normalizeDecimal(row.available_quantity);
        const reserved = this.normalizeDecimal(row.reserved_quantity);
        const damaged = this.normalizeDecimal(row.damaged_quantity);
        const inTransit = this.normalizeDecimal(row.in_transit_quantity);
        const total = this.normalizeDecimal(row.total_quantity);
        return {
          product: {
            id: row.product_id,
            name: row.product_name,
            sku: row.product_sku,
            active: Boolean(row.active),
          },
          availableQuantity: available,
          totalQuantity: total,
          states: [
            { code: 'AVAILABLE', quantity: available },
            { code: 'RESERVED', quantity: reserved },
            { code: 'DAMAGED', quantity: damaged },
            { code: 'IN_TRANSIT', quantity: inTransit },
          ],
        };
      }),
      total: Number(countRows[0]?.total ?? 0),
      scope: {
        branch: { id: scope.branch_id, name: scope.branch_name },
        warehouse: { id: scope.warehouse_id, name: scope.warehouse_name },
      },
    };
  }

  async getBalance(
    tenantId: string,
    warehouseId: string,
    productId: string,
    locationId: string,
  ): Promise<InventoryBalanceData> {
    const rows = await this.dataSource.query<
      Array<{
        product_id: string;
        product_name: string;
        product_sku: string;
        location_id: string;
        location_name: string;
        location_code: string;
        quantity: string | null;
        available_quantity: string | null;
        reserved_quantity: string | null;
        damaged_quantity: string | null;
        in_transit_quantity: string | null;
      }>
    >(
      `SELECT p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              ib.quantity, ib.available_quantity, ib.reserved_quantity,
              ib.damaged_quantity, ib.in_transit_quantity
       FROM products p
       INNER JOIN locations l ON l.id = ? AND l.tenant_id = p.tenant_id
         AND l.warehouse_id = ? AND l.active = TRUE
       LEFT JOIN inventory_balances ib ON ib.tenant_id = p.tenant_id
         AND ib.product_id = p.id AND ib.location_id = l.id
       WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE LIMIT 1`,
      [locationId, warehouseId, productId, tenantId],
    );
    if (!rows[0]) throw new InventoryTargetNotFoundError();
    const total = this.normalizeDecimal(rows[0].quantity ?? '0');
    const available = this.normalizeDecimal(rows[0].available_quantity ?? '0');
    const reserved = this.normalizeDecimal(rows[0].reserved_quantity ?? '0');
    const damaged = this.normalizeDecimal(rows[0].damaged_quantity ?? '0');
    const inTransit = this.normalizeDecimal(rows[0].in_transit_quantity ?? '0');
    return {
      product: {
        id: rows[0].product_id,
        name: rows[0].product_name,
        sku: rows[0].product_sku,
      },
      location: {
        id: rows[0].location_id,
        name: rows[0].location_name,
        code: rows[0].location_code,
      },
      quantity: total,
      availableQuantity: available,
      totalQuantity: total,
      states: [
        { code: 'AVAILABLE', quantity: available },
        { code: 'RESERVED', quantity: reserved },
        { code: 'DAMAGED', quantity: damaged },
        { code: 'IN_TRANSIT', quantity: inTransit },
      ],
    };
  }

  async createMovement(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string;
    dto: CreateInventoryMovementDto;
  }): Promise<{ movement: InventoryMovementData; replay: boolean }> {
    const quantityChange = this.quantityChange(input.dto);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          productId: input.dto.productId,
          locationId: input.dto.locationId,
          type: input.dto.type,
          quantity: quantityChange,
          reason: input.dto.reason,
          reference: input.dto.reference ?? null,
        }),
      )
      .digest('hex');

    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existingReplay = await this.findMovement(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existingReplay) {
            if (existingReplay.request_fingerprint !== fingerprint)
              throw new IdempotencyConflictError();
            return {
              movement: this.toMovement(existingReplay),
              replay: true,
            };
          }
          await this.assertTarget(
            manager,
            input.tenantId,
            input.warehouseId,
            input.dto.productId,
            input.dto.locationId,
          );
          await manager.query(
            `INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity)
           VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE quantity = quantity`,
            [input.tenantId, input.dto.productId, input.dto.locationId],
          );
          const [balance] = await manager.query<
            Array<{ quantity: string; available_quantity: string }>
          >(
            `SELECT quantity, available_quantity FROM inventory_balances
           WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
            [input.tenantId, input.dto.productId, input.dto.locationId],
          );
          const replay = await this.findMovement(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.request_fingerprint !== fingerprint)
              throw new IdempotencyConflictError();
            return { movement: this.toMovement(replay), replay: true };
          }
          if (input.dto.type !== 'INITIAL' && !input.dto.reference) {
            throw new MovementReferenceRequiredError();
          }
          if (input.dto.type === 'INITIAL') {
            const [existing] = await manager.query<
              Array<{ total: number | string }>
            >(
              `SELECT COUNT(*) AS total FROM inventory_movements
             WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [input.tenantId, input.dto.productId, input.dto.locationId],
            );
            if (Number(existing.total) > 0)
              throw new InitialStockAlreadyExistsError();
          }
          const resultingUnits =
            this.toUnits(balance.quantity) + this.toUnits(quantityChange);
          const resultingAvailableUnits =
            this.toUnits(balance.available_quantity) +
            this.toUnits(quantityChange);
          if (resultingUnits < 0n || resultingAvailableUnits < 0n)
            throw new InsufficientStockError();
          const resultingQuantity = this.fromUnits(resultingUnits);
          const resultingAvailable = this.fromUnits(resultingAvailableUnits);
          const movementId = randomUUID();
          await manager.query(
            `UPDATE inventory_balances SET quantity = ?, available_quantity = ?
           WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
            [
              resultingQuantity,
              resultingAvailable,
              input.tenantId,
              input.dto.productId,
              input.dto.locationId,
            ],
          );
          await manager.query(
            `INSERT INTO inventory_movements
            (id, tenant_id, product_id, location_id, type, quantity_change,
             resulting_quantity, reason, reference, idempotency_key,
             request_fingerprint, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              movementId,
              input.tenantId,
              input.dto.productId,
              input.dto.locationId,
              input.dto.type,
              quantityChange,
              resultingQuantity,
              input.dto.reason,
              input.dto.reference ?? null,
              input.idempotencyKey,
              fingerprint,
              input.userId,
            ],
          );
          const movement = await this.findMovement(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (!movement)
            throw new Error('CREATED_INVENTORY_MOVEMENT_NOT_FOUND');
          return { movement: this.toMovement(movement), replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const movement = await this.findMovement(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!movement || movement.request_fingerprint !== fingerprint)
        throw new IdempotencyConflictError();
      return { movement: this.toMovement(movement), replay: true };
    }
  }

  async createStateTransition(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string;
    dto: CreateInventoryStateTransitionDto;
  }): Promise<{ movement: InventoryMovementData; replay: boolean }> {
    if (
      input.dto.fromState === input.dto.toState ||
      (input.dto.fromState !== 'AVAILABLE' && input.dto.toState !== 'AVAILABLE')
    ) {
      throw new InvalidStockStateTransitionError();
    }
    const quantityUnits = this.toUnits(input.dto.quantity);
    if (quantityUnits <= 0n) throw new InvalidStockStateTransitionError();
    const normalizedQuantity = this.fromUnits(quantityUnits);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          productId: input.dto.productId,
          locationId: input.dto.locationId,
          fromState: input.dto.fromState,
          toState: input.dto.toState,
          quantity: normalizedQuantity,
          reason: input.dto.reason,
          reference: input.dto.reference,
        }),
      )
      .digest('hex');

    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existingReplay = await this.findMovement(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existingReplay) {
            if (existingReplay.request_fingerprint !== fingerprint)
              throw new IdempotencyConflictError();
            return {
              movement: this.toMovement(existingReplay),
              replay: true,
            };
          }
          await this.assertTarget(
            manager,
            input.tenantId,
            input.warehouseId,
            input.dto.productId,
            input.dto.locationId,
          );
          await manager.query(
            `INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity)
             VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE quantity = quantity`,
            [input.tenantId, input.dto.productId, input.dto.locationId],
          );
          const replay = await this.findMovement(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.request_fingerprint !== fingerprint)
              throw new IdempotencyConflictError();
            return { movement: this.toMovement(replay), replay: true };
          }
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
            [input.tenantId, input.dto.productId, input.dto.locationId],
          );
          const fromColumn = this.stateColumn(input.dto.fromState);
          const toColumn = this.stateColumn(input.dto.toState);
          const sourceUnits = this.toUnits(balance[fromColumn]);
          if (sourceUnits < quantityUnits)
            throw new InsufficientStockStateError();
          const resultingSource = this.fromUnits(sourceUnits - quantityUnits);
          const resultingTarget = this.fromUnits(
            this.toUnits(balance[toColumn]) + quantityUnits,
          );
          await manager.query(
            `UPDATE inventory_balances SET ${fromColumn} = ?, ${toColumn} = ?
             WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
            [
              resultingSource,
              resultingTarget,
              input.tenantId,
              input.dto.productId,
              input.dto.locationId,
            ],
          );
          await manager.query(
            `INSERT INTO inventory_movements
              (id, tenant_id, product_id, location_id, type, from_state, to_state,
               state_quantity, quantity_change, resulting_quantity, reason, reference,
               idempotency_key, request_fingerprint, created_by_user_id)
             VALUES (?, ?, ?, ?, 'STATE_TRANSITION', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              input.tenantId,
              input.dto.productId,
              input.dto.locationId,
              input.dto.fromState,
              input.dto.toState,
              normalizedQuantity,
              balance.quantity,
              input.dto.reason,
              input.dto.reference,
              input.idempotencyKey,
              fingerprint,
              input.userId,
            ],
          );
          const movement = await this.findMovement(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (!movement) throw new Error('CREATED_STATE_TRANSITION_NOT_FOUND');
          return { movement: this.toMovement(movement), replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const movement = await this.findMovement(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!movement || movement.request_fingerprint !== fingerprint)
        throw new IdempotencyConflictError();
      return { movement: this.toMovement(movement), replay: true };
    }
  }

  private async assertTarget(
    manager: EntityManager,
    tenantId: string,
    warehouseId: string,
    productId: string,
    locationId: string,
  ): Promise<void> {
    const rows = await manager.query<Array<{ product_id: string }>>(
      `SELECT p.id AS product_id FROM products p
       INNER JOIN locations l ON l.id = ? AND l.tenant_id = p.tenant_id
         AND l.warehouse_id = ? AND l.active = TRUE
       WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE LIMIT 1`,
      [locationId, warehouseId, productId, tenantId],
    );
    if (!rows[0]) throw new InventoryTargetNotFoundError();
  }

  private async findMovement(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<MovementRow | null> {
    const rows = await manager.query<MovementRow[]>(
      `SELECT im.id, im.type, im.quantity_change, im.resulting_quantity,
              im.from_state, im.to_state, im.state_quantity,
              im.reason, im.reference, im.request_fingerprint, im.created_at,
              p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code
       FROM inventory_movements im
       INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
       INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
       WHERE im.tenant_id = ? AND im.idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  private quantityChange(dto: CreateInventoryMovementDto): string {
    const units = this.toUnits(dto.quantity);
    if (units === 0n) throw new InsufficientStockError();
    if (dto.type === 'ADJUSTMENT') return this.fromUnits(units);
    if (units < 0n) throw new InsufficientStockError();
    const direction = ['EXIT', 'LOSS', 'DAMAGE'].includes(dto.type) ? -1n : 1n;
    return this.fromUnits(units * direction);
  }

  private toUnits(value: string): bigint {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const units = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
    return negative ? -units : units;
  }

  private stateColumn(
    state: InventoryStockState,
  ):
    | 'available_quantity'
    | 'reserved_quantity'
    | 'damaged_quantity'
    | 'in_transit_quantity' {
    return (
      {
        AVAILABLE: 'available_quantity',
        RESERVED: 'reserved_quantity',
        DAMAGED: 'damaged_quantity',
        IN_TRANSIT: 'in_transit_quantity',
      } as const
    )[state];
  }

  private fromUnits(units: bigint): string {
    const sign = units < 0n ? '-' : '';
    const absolute = units < 0n ? -units : units;
    return `${sign}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`;
  }

  private normalizeDecimal(value: string): string {
    return this.fromUnits(this.toUnits(value));
  }

  private toMovement(row: MovementRow): InventoryMovementData {
    return {
      id: row.id,
      type: row.type,
      quantityChange: this.normalizeDecimal(row.quantity_change),
      quantity: this.normalizeDecimal(row.resulting_quantity),
      reason: row.reason,
      reference: row.reference,
      createdAt: new Date(row.created_at).toISOString(),
      stateTransition:
        row.from_state && row.to_state && row.state_quantity
          ? {
              from: row.from_state,
              to: row.to_state,
              quantity: this.normalizeDecimal(row.state_quantity),
            }
          : null,
      product: {
        id: row.product_id,
        name: row.product_name,
        sku: row.product_sku,
      },
      location: {
        id: row.location_id,
        name: row.location_name,
        code: row.location_code,
      },
    };
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}

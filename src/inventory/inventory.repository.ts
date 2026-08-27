import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { ListInventoryStockDto } from './dto/list-inventory-stock.dto';
import { ListInventoryMovementsDto } from './dto/list-inventory-movements.dto';
import {
  IdempotencyConflictError,
  InitialStockAlreadyExistsError,
  InsufficientStockError,
  InventoryTargetNotFoundError,
  MovementReferenceRequiredError,
} from './inventory.errors';
import {
  InventoryBalanceData,
  InventoryLocationData,
  InventoryMovementType,
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
       WHERE tenant_id = ? AND warehouse_id = ? ORDER BY name, id`,
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
    >('SELECT id, name FROM branches WHERE id = ? AND tenant_id = ? LIMIT 1', [
      branchId,
      tenantId,
    ]);
    if (!branch) throw new InventoryTargetNotFoundError();

    const filters = ['im.tenant_id = ?', 'b.id = ?'];
    const parameters: unknown[] = [tenantId, branchId];
    if (query.productId) {
      filters.push('im.product_id = ?');
      parameters.push(query.productId);
    }
    if (query.q) {
      const search = `%${query.q}%`;
      filters.push(
        '(p.name LIKE ? OR p.normalized_sku LIKE ? OR p.barcode LIKE ?)',
      );
      parameters.push(search, search.toUpperCase(), search);
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
        }>
      >(
        `SELECT im.id, im.type, im.quantity_change, im.resulting_quantity,
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
        direction: row.quantity_change.startsWith('-') ? 'OUT' : 'IN',
        quantityChange: this.normalizeDecimal(row.quantity_change),
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
       WHERE b.id = ? AND w.id = ? AND b.tenant_id = ? LIMIT 1`,
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
          quantity: string;
        }>
      >(
        `SELECT p.id AS product_id, p.name AS product_name, p.sku AS product_sku, p.active,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.quantity ELSE 0 END), 0) AS quantity
         FROM products p
         LEFT JOIN inventory_balances ib ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
         LEFT JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         WHERE ${where}
         GROUP BY p.id, p.name, p.sku, p.active, p.created_at
         ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
        [warehouseId, ...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM products p WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      items: rows.map((row) => {
        const quantity = this.normalizeDecimal(row.quantity);
        return {
          product: {
            id: row.product_id,
            name: row.product_name,
            sku: row.product_sku,
            active: Boolean(row.active),
          },
          availableQuantity: quantity,
          totalQuantity: quantity,
          states: [{ code: 'AVAILABLE', quantity }],
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
      }>
    >(
      `SELECT p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              ib.quantity
       FROM products p
       INNER JOIN locations l ON l.id = ? AND l.tenant_id = p.tenant_id AND l.warehouse_id = ?
       LEFT JOIN inventory_balances ib ON ib.tenant_id = p.tenant_id
         AND ib.product_id = p.id AND ib.location_id = l.id
       WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE LIMIT 1`,
      [locationId, warehouseId, productId, tenantId],
    );
    if (!rows[0]) throw new InventoryTargetNotFoundError();
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
      quantity: this.normalizeDecimal(rows[0].quantity ?? '0'),
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
          const [balance] = await manager.query<Array<{ quantity: string }>>(
            `SELECT quantity FROM inventory_balances
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
          if (resultingUnits < 0n) throw new InsufficientStockError();
          const resultingQuantity = this.fromUnits(resultingUnits);
          const movementId = randomUUID();
          await manager.query(
            `UPDATE inventory_balances SET quantity = ?
           WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
            [
              resultingQuantity,
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

  private async assertTarget(
    manager: EntityManager,
    tenantId: string,
    warehouseId: string,
    productId: string,
    locationId: string,
  ): Promise<void> {
    const rows = await manager.query<Array<{ product_id: string }>>(
      `SELECT p.id AS product_id FROM products p
       INNER JOIN locations l ON l.id = ? AND l.tenant_id = p.tenant_id AND l.warehouse_id = ?
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

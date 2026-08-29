import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  normalizeProductQuantity,
  ProductBaseUnit,
  QuantityRoundingMode,
  quantityFromUnits,
  quantityToUnits,
} from '../common/quantity-policy';
import { applyInventoryValuation } from './inventory-valuation';
import { CreateInventoryKitOperationDto } from './dto/create-inventory-kit-operation.dto';
import {
  InventoryKitIdempotencyConflictError,
  InventoryKitInsufficientStockError,
  InventoryKitNotAssembledError,
  InventoryKitNotFoundError,
} from './inventory-kit.errors';
import { InventoryKitOperationData } from './inventory-kit.types';

interface KitOperationRow {
  id: string;
  tenant_id: string;
  operation_type: 'ASSEMBLE' | 'DISASSEMBLE';
  kit_product_id: string;
  kit_name: string;
  kit_sku: string;
  location_id: string;
  quantity: string;
  request_fingerprint: string;
  created_at: string | Date;
}

@Injectable()
export class InventoryKitRepository {
  constructor(private readonly dataSource: DataSource) {}

  async operate(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    productId: string;
    idempotencyKey: string;
    dto: CreateInventoryKitOperationDto;
  }): Promise<{ operation: InventoryKitOperationData; replay: boolean }> {
    const canonicalQuantity = quantityFromUnits(
      quantityToUnits(input.dto.quantity),
    );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          productId: input.productId,
          locationId: input.dto.locationId,
          operationType: input.dto.operationType,
          quantity: canonicalQuantity,
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
          if (existing) return this.replay(existing, fingerprint);

          const [kit] = await manager.query<
            Array<{
              id: string;
              name: string;
              sku: string;
              stock_mode: 'DERIVED' | 'ASSEMBLED';
              base_unit: ProductBaseUnit;
              quantity_precision: number;
              quantity_rounding: QuantityRoundingMode;
              minimum_quantity: string;
            }>
          >(
            `SELECT p.id, p.name, p.sku, pk.stock_mode, p.base_unit,
                  p.quantity_precision, p.quantity_rounding, p.minimum_quantity
           FROM products p
           INNER JOIN product_kits pk
             ON pk.product_id = p.id AND pk.tenant_id = p.tenant_id
           WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE
             AND (pk.effective_from IS NULL OR pk.effective_from <= CURRENT_DATE())
             AND (pk.effective_to IS NULL OR pk.effective_to >= CURRENT_DATE())
           LIMIT 1 FOR UPDATE`,
            [input.productId, input.tenantId],
          );
          if (!kit) throw new InventoryKitNotFoundError();
          if (kit.stock_mode !== 'ASSEMBLED') {
            throw new InventoryKitNotAssembledError();
          }
          const normalizedQuantity = normalizeProductQuantity(
            canonicalQuantity,
            {
              baseUnit: kit.base_unit,
              precision: Number(kit.quantity_precision),
              rounding: kit.quantity_rounding,
              minimumQuantity: kit.minimum_quantity,
            },
          );
          const kitUnits = quantityToUnits(normalizedQuantity);
          if (kitUnits <= 0n) throw new InventoryKitNotAssembledError();
          const [location] = await manager.query<Array<{ id: string }>>(
            `SELECT l.id FROM locations l
           INNER JOIN warehouses w
             ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
           WHERE l.id = ? AND l.tenant_id = ? AND w.id = ? LIMIT 1`,
            [input.dto.locationId, input.tenantId, input.warehouseId],
          );
          if (!location) throw new InventoryKitNotFoundError();
          const components = await manager.query<
            Array<{
              id: string;
              name: string;
              sku: string;
              quantity: string;
            }>
          >(
            `SELECT p.id, p.name, p.sku, c.quantity
           FROM product_kit_components c
           INNER JOIN products p
             ON p.id = c.component_product_id AND p.tenant_id = c.tenant_id
           WHERE c.tenant_id = ? AND c.kit_product_id = ?
           ORDER BY p.id FOR UPDATE`,
            [input.tenantId, input.productId],
          );
          if (components.length === 0) throw new InventoryKitNotFoundError();
          const changes = new Map<string, bigint>();
          for (const component of components) {
            const componentUnits =
              (kitUnits * quantityToUnits(component.quantity)) / 1000n;
            changes.set(
              component.id,
              input.dto.operationType === 'ASSEMBLE'
                ? -componentUnits
                : componentUnits,
            );
          }
          changes.set(
            input.productId,
            input.dto.operationType === 'ASSEMBLE' ? kitUnits : -kitUnits,
          );
          const operationId = randomUUID();
          for (const productId of [...changes.keys()].sort()) {
            await manager.query(
              `INSERT INTO inventory_balances
               (tenant_id, product_id, location_id, quantity, available_quantity)
             VALUES (?, ?, ?, 0, 0)
             ON DUPLICATE KEY UPDATE quantity = quantity`,
              [input.tenantId, productId, input.dto.locationId],
            );
            const [balance] = await manager.query<
              Array<{ quantity: string; available_quantity: string }>
            >(
              `SELECT quantity, available_quantity FROM inventory_balances
             WHERE tenant_id = ? AND product_id = ? AND location_id = ?
             LIMIT 1 FOR UPDATE`,
              [input.tenantId, productId, input.dto.locationId],
            );
            const change = changes.get(productId)!;
            const currentQuantity = quantityToUnits(balance.quantity);
            const currentAvailable = quantityToUnits(
              balance.available_quantity,
            );
            if (change < 0n && currentAvailable < -change) {
              throw new InventoryKitInsufficientStockError(productId);
            }
            const resultingQuantity = currentQuantity + change;
            const resultingAvailable = currentAvailable + change;
            await manager.query(
              `UPDATE inventory_balances SET quantity = ?, available_quantity = ?
             WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                quantityFromUnits(resultingQuantity),
                quantityFromUnits(resultingAvailable),
                input.tenantId,
                productId,
                input.dto.locationId,
              ],
            );
            const movementId = randomUUID();
            const quantityChange = quantityFromUnits(change);
            const movementKey = `kit:${operationId}:${productId}`;
            await manager.query(
              `INSERT INTO inventory_movements
               (id, tenant_id, product_id, location_id, type, quantity_change,
                resulting_quantity, reason, reference, idempotency_key,
                request_fingerprint, created_by_user_id)
             VALUES (?, ?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
              [
                movementId,
                input.tenantId,
                productId,
                input.dto.locationId,
                quantityChange,
                quantityFromUnits(resultingQuantity),
                input.dto.operationType === 'ASSEMBLE'
                  ? 'Armado de kit'
                  : 'Desarmado de kit',
                operationId,
                movementKey,
                createHash('sha256')
                  .update(`${movementKey}:${quantityChange}`)
                  .digest('hex'),
                input.userId,
              ],
            );
            await applyInventoryValuation(manager, movementId);
          }
          await manager.query(
            `INSERT INTO kit_inventory_operations
             (id, tenant_id, kit_product_id, location_id, operation_type,
              quantity, idempotency_key, request_fingerprint, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              operationId,
              input.tenantId,
              input.productId,
              input.dto.locationId,
              input.dto.operationType,
              normalizedQuantity,
              input.idempotencyKey,
              fingerprint,
              input.userId,
            ],
          );
          const operation = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (!operation) throw new Error('KIT_OPERATION_NOT_FOUND');
          return {
            operation: this.toOperation(operation, components, changes),
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
      return this.replay(existing, fingerprint);
    }
  }

  private async replay(row: KitOperationRow, fingerprint: string) {
    if (row.request_fingerprint !== fingerprint) {
      throw new InventoryKitIdempotencyConflictError();
    }
    const movements = await this.dataSource.query<
      Array<{ id: string; name: string; sku: string; quantity_change: string }>
    >(
      `SELECT p.id, p.name, p.sku, im.quantity_change
       FROM inventory_movements im
       INNER JOIN products p
         ON p.id = im.product_id AND p.tenant_id = im.tenant_id
       WHERE im.tenant_id = ? AND im.reference = ? AND im.product_id <> ?
       ORDER BY p.id`,
      [row.tenant_id, row.id, row.kit_product_id],
    );
    return {
      operation: this.toOperation(
        row,
        movements,
        new Map(
          movements.map((movement) => [
            movement.id,
            quantityToUnits(movement.quantity_change),
          ]),
        ),
      ),
      replay: true,
    };
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ): Promise<KitOperationRow | null> {
    const [row] = await manager.query<KitOperationRow[]>(
      `SELECT o.*, p.name AS kit_name, p.sku AS kit_sku
       FROM kit_inventory_operations o
       INNER JOIN products p
         ON p.id = o.kit_product_id AND p.tenant_id = o.tenant_id
       WHERE o.tenant_id = ? AND o.idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    return row ?? null;
  }

  private toOperation(
    row: KitOperationRow,
    components: Array<{ id: string; name: string; sku: string }>,
    changes: Map<string, bigint>,
  ): InventoryKitOperationData {
    return {
      id: row.id,
      operationType: row.operation_type,
      kit: { id: row.kit_product_id, name: row.kit_name, sku: row.kit_sku },
      locationId: row.location_id,
      quantity: row.quantity,
      components: components.map((component) => ({
        product: component,
        quantityChange: quantityFromUnits(changes.get(component.id) ?? 0n),
      })),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString(),
    };
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string }).code === 'ER_DUP_ENTRY'
    );
  }
}

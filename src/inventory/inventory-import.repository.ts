import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { InventoryImportMode } from './dto/preview-inventory-import.dto';
import {
  InventoryImportHasErrorsError,
  InventoryImportIdempotencyConflictError,
  InventoryImportNotFoundError,
  InventoryImportStaleError,
} from './inventory-import.errors';
import { applyInventoryValuation } from './inventory-valuation';
import { applyInventoryLotTracking } from './inventory-lot-tracking';
import type {
  InventoryImportPreviewRow,
  InventoryImportResponse,
  InventoryImportRowError,
} from './inventory-import.types';
import type { InventoryStockState } from './inventory.types';

export interface ParsedInventoryImportRow {
  rowNumber: number;
  productSku: string;
  locationCode: string;
  state: InventoryStockState | null;
  targetQuantity: string | null;
  reason: string;
  errors: InventoryImportRowError[];
}

interface ImportRowRecord {
  id: string;
  source_row: number;
  product_id: string | null;
  product_name: string | null;
  product_sku: string;
  resolved_product_sku: string | null;
  location_id: string | null;
  location_name: string | null;
  location_code: string;
  resolved_location_code: string | null;
  stock_state: InventoryStockState | null;
  target_quantity: string | null;
  preview_quantity: string | null;
  preview_difference: string | null;
  reason: string;
  errors: string | InventoryImportRowError[] | null;
}

interface ImportRecord {
  id: string;
  mode: InventoryImportMode;
  status: 'PREVIEWED' | 'CONFIRMED';
  source_filename: string;
  row_count: number | string;
  valid_row_count: number | string;
  error_row_count: number | string;
  movement_count: number | string | null;
  confirmed_at: Date | string | null;
}

@Injectable()
export class InventoryImportRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async createPreview(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    correlationId: string;
    mode: InventoryImportMode;
    sourceFilename: string;
    sourceHash: string;
    rows: ParsedInventoryImportRow[];
  }): Promise<InventoryImportResponse> {
    return this.dataSource.transaction(async (manager) => {
      const [warehouse] = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM warehouses
         WHERE id = ? AND tenant_id = ? AND active = TRUE LIMIT 1`,
        [input.warehouseId, input.tenantId],
      );
      if (!warehouse) throw new InventoryImportNotFoundError();

      const [products, locations, balances] = await Promise.all([
        manager.query<
          Array<{
            id: string;
            name: string;
            sku: string;
            normalized_sku: string;
          }>
        >(
          `SELECT id, name, sku, normalized_sku FROM products
           WHERE tenant_id = ? AND active = TRUE`,
          [input.tenantId],
        ),
        manager.query<Array<{ id: string; name: string; code: string }>>(
          `SELECT id, name, code FROM locations
           WHERE tenant_id = ? AND warehouse_id = ? AND active = TRUE`,
          [input.tenantId, input.warehouseId],
        ),
        manager.query<
          Array<{
            product_id: string;
            location_id: string;
            available_quantity: string;
            reserved_quantity: string;
            damaged_quantity: string;
            in_transit_quantity: string;
          }>
        >(
          `SELECT ib.product_id, ib.location_id, ib.available_quantity,
                  ib.reserved_quantity, ib.damaged_quantity, ib.in_transit_quantity
           FROM inventory_balances ib
           INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
           WHERE ib.tenant_id = ? AND l.warehouse_id = ?`,
          [input.tenantId, input.warehouseId],
        ),
      ]);
      const productsBySku = new Map(
        products.map((product) => [product.normalized_sku, product]),
      );
      const locationsByCode = new Map(
        locations.map((location) => [
          location.code.trim().toUpperCase(),
          location,
        ]),
      );
      const balancesByTarget = new Map(
        balances.map((balance) => [
          `${balance.product_id}:${balance.location_id}`,
          balance,
        ]),
      );
      const seenTargets = new Set<string>();
      const previewRows = input.rows.map((row) => {
        const errors = [...row.errors];
        const product =
          productsBySku.get(row.productSku.trim().toUpperCase()) ?? null;
        const location =
          locationsByCode.get(row.locationCode.trim().toUpperCase()) ?? null;
        if (row.productSku && !product) {
          errors.push({
            code: 'PRODUCT_NOT_FOUND',
            message: `No existe un producto activo con SKU ${row.productSku}.`,
          });
        }
        if (row.locationCode && !location) {
          errors.push({
            code: 'LOCATION_NOT_FOUND',
            message: `La ubicación ${row.locationCode} no pertenece a la bodega activa.`,
          });
        }
        if (product && location && row.state) {
          const key = `${product.id}:${location.id}:${row.state}`;
          if (seenTargets.has(key)) {
            errors.push({
              code: 'DUPLICATE_TARGET',
              message:
                'El producto, ubicación y estado están repetidos en el archivo.',
            });
          }
          seenTargets.add(key);
        }
        const balance =
          product && location
            ? balancesByTarget.get(`${product.id}:${location.id}`)
            : undefined;
        const currentQuantity = row.state
          ? this.normalizeDecimal(balance?.[this.stateColumn(row.state)] ?? '0')
          : null;
        const difference =
          currentQuantity !== null && row.targetQuantity !== null
            ? this.fromUnits(
                this.toUnits(row.targetQuantity) -
                  this.toUnits(currentQuantity),
              )
            : null;
        return {
          id: randomUUID(),
          rowNumber: row.rowNumber,
          product,
          location,
          state: row.state,
          targetQuantity: row.targetQuantity,
          currentQuantity,
          difference,
          reason: row.reason,
          errors,
          productSku: row.productSku,
          locationCode: row.locationCode,
        };
      });
      const importId = randomUUID();
      const errorRows = previewRows.filter(
        (row) => row.errors.length > 0,
      ).length;
      await manager.query(
        `INSERT INTO inventory_imports
          (id, tenant_id, warehouse_id, mode, source_filename, source_hash,
           row_count, valid_row_count, error_row_count, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          importId,
          input.tenantId,
          input.warehouseId,
          input.mode,
          input.sourceFilename,
          input.sourceHash,
          previewRows.length,
          previewRows.length - errorRows,
          errorRows,
          input.userId,
        ],
      );
      for (const group of this.chunks(previewRows, 200)) {
        const placeholders = group
          .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .join(', ');
        await manager.query(
          `INSERT INTO inventory_import_rows
            (id, tenant_id, import_id, source_row, product_id, location_id,
             product_sku, location_code, stock_state, target_quantity,
             preview_quantity, preview_difference, reason, errors)
           VALUES ${placeholders}`,
          group.flatMap((row) => [
            row.id,
            input.tenantId,
            importId,
            row.rowNumber,
            row.product?.id ?? null,
            row.location?.id ?? null,
            row.productSku,
            row.locationCode,
            row.state,
            row.targetQuantity,
            row.currentQuantity,
            row.difference,
            row.reason,
            row.errors.length ? JSON.stringify(row.errors) : null,
          ]),
        );
      }
      await this.audit.recordInTransaction(manager, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'INVENTORY_IMPORT_PREVIEWED',
        entityType: 'INVENTORY_IMPORT',
        entityId: importId,
        correlationId: input.correlationId,
        after: {
          mode: input.mode,
          policy: 'ATOMIC',
          rows: previewRows.length,
          validRows: previewRows.length - errorRows,
          errorRows,
          sourceHash: input.sourceHash,
        },
      });
      return this.toResponse(
        {
          id: importId,
          mode: input.mode,
          status: 'PREVIEWED',
          source_filename: input.sourceFilename,
          row_count: previewRows.length,
          valid_row_count: previewRows.length - errorRows,
          error_row_count: errorRows,
          movement_count: null,
          confirmed_at: null,
        },
        previewRows.map((row) => ({
          id: row.id,
          rowNumber: row.rowNumber,
          product: row.product,
          location: row.location,
          state: row.state,
          targetQuantity: row.targetQuantity,
          currentQuantity: row.currentQuantity,
          difference: row.difference,
          reason: row.reason,
          errors: row.errors,
        })),
      );
    });
  }

  async get(
    tenantId: string,
    warehouseId: string,
    importId: string,
  ): Promise<InventoryImportResponse> {
    const result = await this.load(
      this.dataSource.manager,
      tenantId,
      warehouseId,
      importId,
    );
    if (!result) throw new InventoryImportNotFoundError();
    return this.toResponse(result.record, result.rows);
  }

  async confirm(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    importId: string;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<InventoryImportResponse> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const records = await manager.query<ImportRecord[]>(
            `SELECT id, mode, status, source_filename, row_count, valid_row_count,
                error_row_count, movement_count, confirmed_at
         FROM inventory_imports
         WHERE id = ? AND tenant_id = ? AND warehouse_id = ? FOR UPDATE`,
            [input.importId, input.tenantId, input.warehouseId],
          );
          const record = records[0];
          if (!record) throw new InventoryImportNotFoundError();
          if (record.status === 'CONFIRMED') {
            const loaded = await this.loadRows(
              manager,
              input.tenantId,
              input.importId,
            );
            return this.toResponse(record, loaded, true);
          }
          if (Number(record.error_row_count) > 0)
            throw new InventoryImportHasErrorsError();
          const [keyOwner] = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM inventory_imports
         WHERE tenant_id = ? AND confirmation_idempotency_key = ? AND id <> ? LIMIT 1`,
            [input.tenantId, input.idempotencyKey, input.importId],
          );
          if (keyOwner) throw new InventoryImportIdempotencyConflictError();

          const rows = await this.loadRows(
            manager,
            input.tenantId,
            input.importId,
          );
          const orderedRows = [...rows].sort((left, right) =>
            `${left.product?.id}:${left.location?.id}:${left.state}`.localeCompare(
              `${right.product?.id}:${right.location?.id}:${right.state}`,
            ),
          );
          let movementCount = 0;
          for (const row of orderedRows) {
            if (
              !row.product ||
              !row.location ||
              !row.state ||
              !row.targetQuantity
            )
              throw new InventoryImportHasErrorsError();
            const [target] = await manager.query<Array<{ ok: number }>>(
              `SELECT 1 AS ok FROM products p
           INNER JOIN locations l ON l.id = ? AND l.tenant_id = p.tenant_id
             AND l.warehouse_id = ? AND l.active = TRUE
           WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE LIMIT 1`,
              [
                row.location.id,
                input.warehouseId,
                row.product.id,
                input.tenantId,
              ],
            );
            if (!target) throw new InventoryImportStaleError();
            const movementId = randomUUID();
            await manager.query(
              `INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity)
           VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE quantity = quantity`,
              [input.tenantId, row.product.id, row.location.id],
            );
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
              [input.tenantId, row.product.id, row.location.id],
            );
            const stateColumn = this.stateColumn(row.state);
            const current = this.normalizeDecimal(balance[stateColumn]);
            if (current !== row.currentQuantity)
              throw new InventoryImportStaleError();
            const differenceUnits =
              this.toUnits(row.targetQuantity) - this.toUnits(current);
            if (differenceUnits === 0n) continue;
            const resultingUnits =
              this.toUnits(balance.quantity) + differenceUnits;
            const resultingQuantity = this.fromUnits(resultingUnits);
            await manager.query(
              `UPDATE inventory_balances SET quantity = ?, ${stateColumn} = ?
           WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                resultingQuantity,
                row.targetQuantity,
                input.tenantId,
                row.product.id,
                row.location.id,
              ],
            );
            const quantityChange = this.fromUnits(differenceUnits);
            const movementKey = `import:${input.importId}:${row.rowNumber}`;
            const fingerprint = createHash('sha256')
              .update(
                JSON.stringify({
                  importId: input.importId,
                  rowId: row.id,
                  productId: row.product.id,
                  locationId: row.location.id,
                  state: row.state,
                  targetQuantity: row.targetQuantity,
                  quantityChange,
                }),
              )
              .digest('hex');
            await manager.query(
              `INSERT INTO inventory_movements
            (id, tenant_id, product_id, location_id, type, quantity_change,
             resulting_quantity, reason, reference, idempotency_key,
             request_fingerprint, created_by_user_id, inventory_import_id,
             inventory_import_row_id)
           VALUES (?, ?, ?, ?, 'IMPORT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                movementId,
                input.tenantId,
                row.product.id,
                row.location.id,
                quantityChange,
                resultingQuantity,
                row.reason,
                `IMPORT:${input.importId}`,
                movementKey,
                fingerprint,
                input.userId,
                input.importId,
                row.id,
              ],
            );
            await applyInventoryValuation(manager, movementId);
            await applyInventoryLotTracking(manager, movementId);
            movementCount += 1;
          }
          await manager.query(
            `UPDATE inventory_imports
         SET status = 'CONFIRMED', movement_count = ?, confirmed_by_user_id = ?,
             confirmation_idempotency_key = ?, confirmed_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND tenant_id = ?`,
            [
              movementCount,
              input.userId,
              input.idempotencyKey,
              input.importId,
              input.tenantId,
            ],
          );
          await this.audit.recordInTransaction(manager, {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: 'INVENTORY_IMPORT_CONFIRMED',
            entityType: 'INVENTORY_IMPORT',
            entityId: input.importId,
            correlationId: input.correlationId,
            before: { status: 'PREVIEWED' },
            after: {
              status: 'CONFIRMED',
              policy: 'ATOMIC',
              rows: Number(record.row_count),
              movements: movementCount,
            },
          });
          const [confirmed] = await manager.query<ImportRecord[]>(
            `SELECT id, mode, status, source_filename, row_count, valid_row_count,
                error_row_count, movement_count, confirmed_at
         FROM inventory_imports WHERE id = ? AND tenant_id = ?`,
            [input.importId, input.tenantId],
          );
          return this.toResponse(confirmed, rows, false);
        },
      );
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { errno?: number }).errno === 1062
      ) {
        throw new InventoryImportIdempotencyConflictError();
      }
      throw error;
    }
  }

  private async load(
    manager: EntityManager,
    tenantId: string,
    warehouseId: string,
    importId: string,
  ): Promise<{
    record: ImportRecord;
    rows: InventoryImportPreviewRow[];
  } | null> {
    const [record] = await manager.query<ImportRecord[]>(
      `SELECT id, mode, status, source_filename, row_count, valid_row_count,
              error_row_count, movement_count, confirmed_at
       FROM inventory_imports
       WHERE id = ? AND tenant_id = ? AND warehouse_id = ? LIMIT 1`,
      [importId, tenantId, warehouseId],
    );
    if (!record) return null;
    return { record, rows: await this.loadRows(manager, tenantId, importId) };
  }

  private async loadRows(
    manager: EntityManager,
    tenantId: string,
    importId: string,
  ): Promise<InventoryImportPreviewRow[]> {
    const rows = await manager.query<ImportRowRecord[]>(
      `SELECT iir.id, iir.source_row, iir.product_id, p.name AS product_name,
              iir.product_sku, p.sku AS resolved_product_sku,
              iir.location_id, l.name AS location_name, iir.location_code,
              l.code AS resolved_location_code, iir.stock_state,
              iir.target_quantity, iir.preview_quantity, iir.preview_difference,
              iir.reason, iir.errors
       FROM inventory_import_rows iir
       LEFT JOIN products p ON p.id = iir.product_id AND p.tenant_id = iir.tenant_id
       LEFT JOIN locations l ON l.id = iir.location_id AND l.tenant_id = iir.tenant_id
       WHERE iir.import_id = ? AND iir.tenant_id = ? ORDER BY iir.source_row`,
      [importId, tenantId],
    );
    return rows.map((row) => ({
      id: row.id,
      rowNumber: Number(row.source_row),
      product:
        row.product_id && row.product_name && row.resolved_product_sku
          ? {
              id: row.product_id,
              name: row.product_name,
              sku: row.resolved_product_sku,
            }
          : null,
      location:
        row.location_id && row.location_name && row.resolved_location_code
          ? {
              id: row.location_id,
              name: row.location_name,
              code: row.resolved_location_code,
            }
          : null,
      state: row.stock_state,
      targetQuantity: row.target_quantity
        ? this.normalizeDecimal(row.target_quantity)
        : null,
      currentQuantity: row.preview_quantity
        ? this.normalizeDecimal(row.preview_quantity)
        : null,
      difference: row.preview_difference
        ? this.normalizeDecimal(row.preview_difference)
        : null,
      reason: row.reason,
      errors: this.parseErrors(row.errors),
    }));
  }

  private toResponse(
    record: ImportRecord,
    rows: InventoryImportPreviewRow[],
    idempotentReplay?: boolean,
  ): InventoryImportResponse {
    return {
      data: {
        id: record.id,
        mode: record.mode,
        status: record.status,
        sourceFilename: record.source_filename,
        policy: 'ATOMIC',
        canConfirm:
          record.status === 'PREVIEWED' && Number(record.error_row_count) === 0,
        summary: {
          rows: Number(record.row_count),
          validRows: Number(record.valid_row_count),
          errorRows: Number(record.error_row_count),
          movements:
            record.movement_count === null
              ? null
              : Number(record.movement_count),
        },
        rows,
        confirmedAt: record.confirmed_at
          ? new Date(record.confirmed_at).toISOString()
          : null,
      },
      meta: {
        apiVersion: '1',
        ...(idempotentReplay === undefined ? {} : { idempotentReplay }),
      },
    };
  }

  private parseErrors(
    errors: string | InventoryImportRowError[] | null,
  ): InventoryImportRowError[] {
    if (!errors) return [];
    return typeof errors === 'string'
      ? (JSON.parse(errors) as InventoryImportRowError[])
      : errors;
  }

  private stateColumn(
    state: InventoryStockState,
  ):
    | 'available_quantity'
    | 'reserved_quantity'
    | 'damaged_quantity'
    | 'in_transit_quantity' {
    return {
      AVAILABLE: 'available_quantity',
      RESERVED: 'reserved_quantity',
      DAMAGED: 'damaged_quantity',
      IN_TRANSIT: 'in_transit_quantity',
    }[state] as
      | 'available_quantity'
      | 'reserved_quantity'
      | 'damaged_quantity'
      | 'in_transit_quantity';
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

  private chunks<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size));
    }
    return result;
  }
}

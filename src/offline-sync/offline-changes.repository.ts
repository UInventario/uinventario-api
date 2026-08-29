import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { OfflineSyncEntityV1 } from './offline-sync-v1.contract';

@Injectable()
export class OfflineChangesRepository {
  constructor(private readonly dataSource: DataSource) {}

  async tombstones(input: {
    tenantId: string;
    since: string;
    until: string;
    branchIds: string[];
    catalogAllowed: boolean;
  }): Promise<OfflineSyncEntityV1[]> {
    const entities: OfflineSyncEntityV1[] = [];
    if (input.branchIds.length) {
      const placeholders = input.branchIds.map(() => '?').join(', ');
      const branches = await this.dataSource.query<
        Array<{
          id: string;
          name: string;
          timezone: string;
          updated_at: string | Date;
        }>
      >(
        `SELECT id, name, timezone, updated_at FROM branches
         WHERE tenant_id = ? AND active = FALSE AND updated_at > ? AND updated_at <= ?
           AND id IN (${placeholders})`,
        [input.tenantId, input.since, input.until, ...input.branchIds],
      );
      const warehouses = await this.dataSource.query<
        Array<{
          id: string;
          branch_id: string;
          name: string;
          updated_at: string | Date;
        }>
      >(
        `SELECT id, branch_id, name, updated_at FROM warehouses
         WHERE tenant_id = ? AND active = FALSE AND updated_at > ? AND updated_at <= ?
           AND branch_id IN (${placeholders})`,
        [input.tenantId, input.since, input.until, ...input.branchIds],
      );
      const warehouseIds = warehouses.map(({ id }) => id);
      const locations = warehouseIds.length
        ? await this.dataSource.query<
            Array<{
              id: string;
              warehouse_id: string;
              code: string;
              name: string;
              updated_at: string | Date;
            }>
          >(
            `SELECT id, warehouse_id, code, name, updated_at FROM locations
             WHERE tenant_id = ? AND active = FALSE AND updated_at > ? AND updated_at <= ?
               AND warehouse_id IN (${warehouseIds.map(() => '?').join(', ')})`,
            [input.tenantId, input.since, input.until, ...warehouseIds],
          )
        : [];
      entities.push(
        ...branches.map((row) => ({
          kind: 'BRANCH' as const,
          id: row.id,
          tenantId: input.tenantId,
          version: this.version(row.updated_at),
          updatedAt: this.iso(row.updated_at),
          name: row.name,
          timezone: row.timezone,
          active: false,
        })),
        ...warehouses.map((row) => ({
          kind: 'WAREHOUSE' as const,
          id: row.id,
          tenantId: input.tenantId,
          version: this.version(row.updated_at),
          updatedAt: this.iso(row.updated_at),
          branchId: row.branch_id,
          name: row.name,
          active: false,
        })),
        ...locations.map((row) => ({
          kind: 'LOCATION' as const,
          id: row.id,
          tenantId: input.tenantId,
          version: this.version(row.updated_at),
          updatedAt: this.iso(row.updated_at),
          warehouseId: row.warehouse_id,
          code: row.code,
          name: row.name,
          active: false,
        })),
      );
    }
    if (input.catalogAllowed) {
      const products = await this.dataSource.query<
        Array<{
          id: string;
          sku: string;
          barcode: string | null;
          name: string;
          category_id: string | null;
          brand_id: string | null;
          price: string;
          base_unit: import('../common/quantity-policy').ProductBaseUnit;
          quantity_precision: number;
          quantity_rounding: import('../common/quantity-policy').QuantityRoundingMode;
          minimum_quantity: string;
          version: number;
          updated_at: string | Date;
        }>
      >(
        `SELECT id, sku, barcode, name, category_id, brand_id, price, base_unit,
                quantity_precision, quantity_rounding, minimum_quantity, version, updated_at
         FROM products WHERE tenant_id = ? AND active = FALSE AND variant_schema IS NULL
           AND updated_at > ? AND updated_at <= ?`,
        [input.tenantId, input.since, input.until],
      );
      entities.push(
        ...products.map((row) => ({
          kind: 'PRODUCT' as const,
          id: row.id,
          tenantId: input.tenantId,
          version: Number(row.version),
          updatedAt: this.iso(row.updated_at),
          sku: row.sku,
          barcode: row.barcode,
          name: row.name,
          categoryId: row.category_id,
          brandId: row.brand_id,
          price: this.decimal(row.price, 2),
          baseUnit: row.base_unit,
          quantityPrecision: Number(row.quantity_precision),
          quantityRounding: row.quantity_rounding,
          minimumQuantity: this.decimal(row.minimum_quantity, 3),
          active: false,
        })),
      );
      const hardDeletes = await this.dataSource.query<
        Array<{
          entity_id: string;
          payload: string | Record<string, unknown>;
          occurred_at: string | Date;
        }>
      >(
        `SELECT entity_id, payload, occurred_at FROM offline_sync_tombstones
         WHERE tenant_id = ? AND entity_kind = 'PRODUCT'
           AND occurred_at > ? AND occurred_at <= ?`,
        [input.tenantId, input.since, input.until],
      );
      entities.push(
        ...hardDeletes.map((row) => {
          const payload =
            typeof row.payload === 'string'
              ? (JSON.parse(row.payload) as Record<string, unknown>)
              : row.payload;
          return {
            kind: 'PRODUCT' as const,
            id: row.entity_id,
            tenantId: input.tenantId,
            version: Number(payload.version),
            updatedAt: this.iso(row.occurred_at),
            sku: this.scalar(payload.sku),
            barcode: this.nullableScalar(payload.barcode),
            name: this.scalar(payload.name),
            categoryId: this.nullableScalar(payload.categoryId),
            brandId: this.nullableScalar(payload.brandId),
            price: this.scalar(payload.price),
            baseUnit: (this.scalar(payload.baseUnit) ||
              'UNIT') as import('../common/quantity-policy').ProductBaseUnit,
            quantityPrecision: Number(payload.quantityPrecision ?? 3),
            quantityRounding: (this.scalar(payload.quantityRounding) ||
              'HALF_UP') as import('../common/quantity-policy').QuantityRoundingMode,
            minimumQuantity: this.scalar(payload.minimumQuantity) || '0.001',
            active: false,
          };
        }),
      );
    }
    return entities;
  }

  private iso(value: string | Date): string {
    if (value instanceof Date) {
      return new Date(
        Date.UTC(
          value.getFullYear(),
          value.getMonth(),
          value.getDate(),
          value.getHours(),
          value.getMinutes(),
          value.getSeconds(),
          value.getMilliseconds(),
        ),
      ).toISOString();
    }
    return new Date(value).toISOString();
  }

  private version(value: string | Date): number {
    return Math.max(1, new Date(this.iso(value)).getTime());
  }

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }

  private scalar(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';
  }

  private nullableScalar(value: unknown): string | null {
    return value === null || value === undefined ? null : this.scalar(value);
  }
}

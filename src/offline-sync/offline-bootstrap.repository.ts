import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import type {
  OfflineSyncEntityV1,
  OfflineSyncScopeV1,
} from './offline-sync-v1.contract';

interface StructureRow {
  id: string;
  name: string;
  created_at: Date | string;
  updated_at: Date | string;
  active?: number | boolean;
  timezone?: string;
  branch_id?: string;
  warehouse_id?: string;
  code?: string;
}

@Injectable()
export class OfflineBootstrapRepository {
  constructor(private readonly dataSource: DataSource) {}

  async entities(input: {
    scope: OfflineSyncScopeV1;
    administrator: boolean;
    permissions: string[];
    snapshotAt: string;
  }): Promise<OfflineSyncEntityV1[]> {
    const branchRows = await this.dataSource.query<StructureRow[]>(
      `SELECT b.id, b.name, b.timezone, b.active, b.created_at, b.updated_at
       FROM branches b
       WHERE b.tenant_id = ? AND b.active = TRUE AND b.updated_at <= ?
         AND (? = TRUE OR EXISTS (
           SELECT 1 FROM user_branch_access uba
           WHERE uba.tenant_id = b.tenant_id AND uba.user_id = ? AND uba.branch_id = b.id
         ))
       ORDER BY b.id`,
      [
        input.scope.tenantId,
        input.snapshotAt,
        input.administrator,
        input.scope.userId,
      ],
    );
    const branchIds = branchRows.map(({ id }) => id);
    if (branchIds.length === 0) return [];
    const inBranches = branchIds.map(() => '?').join(', ');
    const [warehouseRows, cashRegisterRows] = await Promise.all([
      this.dataSource.query<StructureRow[]>(
        `SELECT id, branch_id, name, active, created_at, updated_at FROM warehouses
         WHERE tenant_id = ? AND active = TRUE AND updated_at <= ?
           AND branch_id IN (${inBranches}) ORDER BY id`,
        [input.scope.tenantId, input.snapshotAt, ...branchIds],
      ),
      this.dataSource.query<StructureRow[]>(
        `SELECT cr.id, cr.branch_id, cr.name, cr.code, cr.created_at, cr.updated_at
         FROM cash_registers cr
         WHERE cr.tenant_id = ? AND cr.updated_at <= ?
           AND cr.branch_id IN (${inBranches})
           AND (? = TRUE OR EXISTS (
             SELECT 1 FROM user_cash_register_access ucra
             WHERE ucra.tenant_id = cr.tenant_id AND ucra.user_id = ?
               AND ucra.branch_id = cr.branch_id AND ucra.cash_register_id = cr.id
           )) ORDER BY cr.id`,
        [
          input.scope.tenantId,
          input.snapshotAt,
          ...branchIds,
          input.administrator,
          input.scope.userId,
        ],
      ),
    ]);
    const warehouseIds = warehouseRows.map(({ id }) => id);
    const locationRows = warehouseIds.length
      ? await this.dataSource.query<StructureRow[]>(
          `SELECT id, warehouse_id, name, code, active, created_at, updated_at FROM locations
           WHERE tenant_id = ? AND active = TRUE AND updated_at <= ?
             AND warehouse_id IN (${warehouseIds.map(() => '?').join(', ')}) ORDER BY id`,
          [input.scope.tenantId, input.snapshotAt, ...warehouseIds],
        )
      : [];
    const entities: OfflineSyncEntityV1[] = [
      ...branchRows.map((row) => ({
        ...this.base(row, input.scope.tenantId),
        kind: 'BRANCH' as const,
        name: row.name,
        timezone: row.timezone!,
        active: true,
      })),
      ...warehouseRows.map((row) => ({
        ...this.base(row, input.scope.tenantId),
        kind: 'WAREHOUSE' as const,
        branchId: row.branch_id!,
        name: row.name,
        active: true,
      })),
      ...locationRows.map((row) => ({
        ...this.base(row, input.scope.tenantId),
        kind: 'LOCATION' as const,
        warehouseId: row.warehouse_id!,
        code: row.code!,
        name: row.name,
        active: true,
      })),
      ...cashRegisterRows.map((row) => ({
        ...this.base(row, input.scope.tenantId),
        kind: 'CASH_REGISTER' as const,
        branchId: row.branch_id!,
        code: row.code!,
        name: row.name,
        active: true,
      })),
    ];
    const catalogAllowed = input.permissions.some((permission) =>
      ['PRODUCTS_MANAGE', 'SALES_MANAGE', 'INVENTORY_VIEW'].includes(
        permission,
      ),
    );
    if (!catalogAllowed) return entities;
    const products = await this.dataSource.query<
      Array<{
        id: string;
        name: string;
        sku: string;
        barcode: string | null;
        category_id: string | null;
        category_name: string | null;
        category_created_at: Date | string | null;
        brand_id: string | null;
        brand_name: string | null;
        brand_created_at: Date | string | null;
        price: string;
        base_unit: import('../common/quantity-policy').ProductBaseUnit;
        quantity_precision: number;
        quantity_rounding: import('../common/quantity-policy').QuantityRoundingMode;
        minimum_quantity: string;
        version: number;
        updated_at: Date | string;
      }>
    >(
      `SELECT p.id, p.name, p.sku, p.barcode, p.category_id,
              c.name AS category_name, c.created_at AS category_created_at,
              p.brand_id, br.name AS brand_name, br.created_at AS brand_created_at,
              p.price, p.base_unit, p.quantity_precision, p.quantity_rounding,
              p.minimum_quantity, p.version, p.updated_at
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
       LEFT JOIN brands br ON br.id = p.brand_id AND br.tenant_id = p.tenant_id
       WHERE p.tenant_id = ? AND p.active = TRUE AND p.variant_schema IS NULL
         AND p.updated_at <= ? ORDER BY p.id`,
      [input.scope.tenantId, input.snapshotAt],
    );
    const classifications = new Map<string, OfflineSyncEntityV1>();
    for (const product of products) {
      if (product.category_id)
        classifications.set(`CATEGORY:${product.category_id}`, {
          kind: 'CATEGORY',
          id: product.category_id,
          tenantId: input.scope.tenantId,
          version: 1,
          updatedAt: this.iso(product.category_created_at!),
          name: product.category_name!,
          active: true,
        });
      if (product.brand_id)
        classifications.set(`BRAND:${product.brand_id}`, {
          kind: 'BRAND',
          id: product.brand_id,
          tenantId: input.scope.tenantId,
          version: 1,
          updatedAt: this.iso(product.brand_created_at!),
          name: product.brand_name!,
          active: true,
        });
    }
    entities.push(
      ...classifications.values(),
      ...products.map((product) => ({
        kind: 'PRODUCT' as const,
        id: product.id,
        tenantId: input.scope.tenantId,
        version: Number(product.version),
        updatedAt: this.iso(product.updated_at),
        sku: product.sku,
        barcode: product.barcode,
        name: product.name,
        categoryId: product.category_id,
        brandId: product.brand_id,
        price: this.decimal(product.price, 2),
        baseUnit: product.base_unit,
        quantityPrecision: Number(product.quantity_precision),
        quantityRounding: product.quantity_rounding,
        minimumQuantity: this.decimal(product.minimum_quantity, 3),
        active: true,
      })),
    );
    if (input.permissions.includes('SALES_MANAGE')) {
      const priceLists = await this.dataSource.query<
        Array<{
          id: string;
          name: string;
          currency: string;
          branch_id: string | null;
          customer_id: string | null;
          channel: 'POS' | 'WEB' | 'MOBILE' | 'DESKTOP' | null;
          priority: number | string;
          valid_from: Date | string;
          valid_to: Date | string | null;
          active: number | boolean;
          version: number | string;
          updated_at: Date | string;
        }>
      >(
        `SELECT id, name, currency, branch_id, customer_id, channel, priority,
                valid_from, valid_to, active, version, updated_at
         FROM price_lists WHERE tenant_id = ? AND updated_at <= ? ORDER BY id`,
        [input.scope.tenantId, input.snapshotAt],
      );
      const priceItems = priceLists.length
        ? await this.dataSource.query<
            Array<{
              price_list_id: string;
              product_id: string;
              price: string;
            }>
          >(
            `SELECT price_list_id, product_id, price FROM price_list_items
             WHERE tenant_id = ? AND price_list_id IN (${priceLists.map(() => '?').join(', ')})
             ORDER BY price_list_id, product_id`,
            [input.scope.tenantId, ...priceLists.map(({ id }) => id)],
          )
        : [];
      entities.push(
        ...priceLists.map((list) => ({
          kind: 'PRICE_LIST' as const,
          id: list.id,
          tenantId: input.scope.tenantId,
          version: Number(list.version),
          updatedAt: this.iso(list.updated_at),
          name: list.name,
          currency: list.currency,
          branchId: list.branch_id,
          customerId: list.customer_id,
          channel: list.channel,
          priority: Number(list.priority),
          validFrom: this.iso(list.valid_from),
          validTo: list.valid_to ? this.iso(list.valid_to) : null,
          active: Boolean(list.active),
          items: priceItems
            .filter(({ price_list_id }) => price_list_id === list.id)
            .map((item) => ({
              productId: item.product_id,
              price: this.decimal(item.price, 2),
            })),
        })),
      );
    }
    if (
      locationRows.length &&
      input.permissions.some((permission) =>
        ['SALES_MANAGE', 'INVENTORY_VIEW'].includes(permission),
      )
    ) {
      const locationIds = locationRows.map(({ id }) => id);
      const balances = await this.dataSource.query<
        Array<{
          product_id: string;
          location_id: string;
          available_quantity: string;
          updated_at: Date | string;
        }>
      >(
        `SELECT product_id, location_id, available_quantity, updated_at
         FROM inventory_balances WHERE tenant_id = ? AND updated_at <= ?
           AND location_id IN (${locationIds.map(() => '?').join(', ')}) ORDER BY product_id, location_id`,
        [input.scope.tenantId, input.snapshotAt, ...locationIds],
      );
      entities.push(
        ...balances.map((balance) => ({
          kind: 'INVENTORY_AVAILABILITY' as const,
          id: this.balanceId(
            input.scope.tenantId,
            balance.product_id,
            balance.location_id,
          ),
          tenantId: input.scope.tenantId,
          version: Math.max(1, new Date(balance.updated_at).getTime()),
          updatedAt: this.iso(balance.updated_at),
          productId: balance.product_id,
          locationId: balance.location_id,
          availableQuantity: this.decimal(balance.available_quantity, 3),
        })),
      );
    }
    return entities.sort((left, right) =>
      left.kind === right.kind
        ? left.id.localeCompare(right.id)
        : left.kind.localeCompare(right.kind),
    );
  }

  private base(row: StructureRow, tenantId: string) {
    return {
      id: row.id,
      tenantId,
      version: 1,
      updatedAt: this.iso(row.updated_at),
    };
  }

  private balanceId(
    tenantId: string,
    productId: string,
    locationId: string,
  ): string {
    const value = createHash('sha256')
      .update(`${tenantId}:${productId}:${locationId}`)
      .digest('hex')
      .slice(0, 32);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
  }

  private iso(value: Date | string): string {
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

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }
}

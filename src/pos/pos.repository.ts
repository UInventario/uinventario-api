import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PosContextNotFoundError } from './pos.errors';
import { PosProductSnapshot } from './pos.types';

@Injectable()
export class PosRepository {
  constructor(private readonly dataSource: DataSource) {}

  async getContext(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
  }): Promise<{
    countryCode: string;
    timezone: string;
    branch: { id: string; name: string };
    warehouse: { id: string; name: string };
    cashRegister: { id: string; name: string; code: string };
  }> {
    const rows = await this.dataSource.query<
      Array<{
        country_code: string;
        timezone: string;
        branch_id: string;
        branch_name: string;
        warehouse_id: string;
        warehouse_name: string;
        cash_register_id: string;
        cash_register_name: string;
        cash_register_code: string;
      }>
    >(
      `SELECT t.country_code, b.timezone, b.id AS branch_id, b.name AS branch_name,
              w.id AS warehouse_id, w.name AS warehouse_name,
              cr.id AS cash_register_id, cr.name AS cash_register_name,
              cr.code AS cash_register_code
       FROM tenants t
       INNER JOIN branches b ON b.id = ? AND b.tenant_id = t.id
       INNER JOIN warehouses w ON w.id = ? AND w.branch_id = b.id AND w.tenant_id = t.id
       INNER JOIN cash_registers cr ON cr.id = ? AND cr.branch_id = b.id AND cr.tenant_id = t.id
       WHERE t.id = ? LIMIT 1`,
      [input.branchId, input.warehouseId, input.cashRegisterId, input.tenantId],
    );
    if (!rows[0]) throw new PosContextNotFoundError();
    const row = rows[0];
    return {
      countryCode: row.country_code,
      timezone: row.timezone,
      branch: { id: row.branch_id, name: row.branch_name },
      warehouse: { id: row.warehouse_id, name: row.warehouse_name },
      cashRegister: {
        id: row.cash_register_id,
        name: row.cash_register_name,
        code: row.cash_register_code,
      },
    };
  }

  async getProducts(
    tenantId: string,
    warehouseId: string,
    productIds: string[],
    reservationId?: string,
    currentDate?: string,
  ): Promise<PosProductSnapshot[]> {
    const placeholders = productIds.map(() => '?').join(', ');
    if (reservationId) {
      const rows = await this.dataSource.query<
        Array<{
          id: string;
          name: string;
          sku: string;
          code_mode: 'EXPLICIT' | 'GENERATED';
          stock_behavior: 'TRACKED' | 'UNTRACKED';
          tax_behavior: 'STANDARD' | 'EXEMPT';
          price: string;
          active: number | boolean;
          track_lots: number | boolean;
          allow_expired_stock_override: number | boolean;
          track_serials: number | boolean;
          base_unit: PosProductSnapshot['baseUnit'];
          quantity_precision: number;
          quantity_rounding: PosProductSnapshot['quantityRounding'];
          minimum_quantity: string;
          available_quantity: string;
        }>
      >(
        `SELECT p.id, p.name, p.sku, p.code_mode, p.stock_behavior,
                p.tax_behavior, p.price, p.active, p.track_lots,
                p.allow_expired_stock_override, p.track_serials,
                p.base_unit, p.quantity_precision, p.quantity_rounding, p.minimum_quantity,
                rl.quantity AS available_quantity
         FROM product_reservations r
         INNER JOIN product_reservation_lines rl
           ON rl.reservation_id = r.id AND rl.tenant_id = r.tenant_id
         INNER JOIN products p ON p.id = rl.product_id AND p.tenant_id = r.tenant_id
         WHERE r.id = ? AND r.tenant_id = ? AND r.warehouse_id = ?
           AND r.status = 'ACTIVE' AND r.expires_at > CURRENT_TIMESTAMP(6)
           AND p.id IN (${placeholders})`,
        [reservationId, tenantId, warehouseId, ...productIds],
      );
      const products = await this.capExpiredLotAvailability(
        tenantId,
        warehouseId,
        currentDate,
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          sku: row.sku,
          withoutCode: row.code_mode === 'GENERATED',
          stockBehavior: row.stock_behavior,
          taxBehavior: row.tax_behavior,
          price: row.price,
          active: Boolean(row.active),
          trackLots: Boolean(row.track_lots),
          allowExpiredStockOverride: Boolean(row.allow_expired_stock_override),
          trackSerials: Boolean(row.track_serials),
          baseUnit: row.base_unit,
          quantityPrecision: Number(row.quantity_precision),
          quantityRounding: row.quantity_rounding,
          minimumQuantity: row.minimum_quantity,
          availableQuantity: this.normalizeQuantity(row.available_quantity),
        })),
      );
      return this.attachKits(tenantId, warehouseId, currentDate, products);
    }
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        name: string;
        sku: string;
        code_mode: 'EXPLICIT' | 'GENERATED';
        stock_behavior: 'TRACKED' | 'UNTRACKED';
        tax_behavior: 'STANDARD' | 'EXEMPT';
        price: string;
        active: number | boolean;
        track_lots: number | boolean;
        allow_expired_stock_override: number | boolean;
        track_serials: number | boolean;
        base_unit: PosProductSnapshot['baseUnit'];
        quantity_precision: number;
        quantity_rounding: PosProductSnapshot['quantityRounding'];
        minimum_quantity: string;
        available_quantity: string;
      }>
    >(
      `SELECT p.id, p.name, p.sku, p.code_mode, p.stock_behavior,
              p.tax_behavior, p.price, p.active, p.track_lots,
              p.allow_expired_stock_override, p.track_serials,
              p.base_unit, p.quantity_precision, p.quantity_rounding, p.minimum_quantity,
              COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.available_quantity ELSE 0 END), 0) AS available_quantity
       FROM products p
       LEFT JOIN inventory_balances ib ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
       LEFT JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       WHERE p.tenant_id = ? AND p.variant_schema IS NULL
         AND p.id IN (${placeholders})
       GROUP BY p.id, p.name, p.sku, p.code_mode, p.stock_behavior,
                p.tax_behavior, p.price, p.active, p.track_lots,
                p.allow_expired_stock_override, p.track_serials, p.base_unit,
                p.quantity_precision, p.quantity_rounding, p.minimum_quantity`,
      [warehouseId, tenantId, ...productIds],
    );
    const products = await this.capExpiredLotAvailability(
      tenantId,
      warehouseId,
      currentDate,
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        sku: row.sku,
        withoutCode: row.code_mode === 'GENERATED',
        stockBehavior: row.stock_behavior,
        taxBehavior: row.tax_behavior,
        price: row.price,
        active: Boolean(row.active),
        trackLots: Boolean(row.track_lots),
        allowExpiredStockOverride: Boolean(row.allow_expired_stock_override),
        trackSerials: Boolean(row.track_serials),
        baseUnit: row.base_unit,
        quantityPrecision: Number(row.quantity_precision),
        quantityRounding: row.quantity_rounding,
        minimumQuantity: row.minimum_quantity,
        availableQuantity: this.normalizeQuantity(row.available_quantity),
      })),
    );
    return this.attachKits(tenantId, warehouseId, currentDate, products);
  }

  private async attachKits(
    tenantId: string,
    warehouseId: string,
    currentDate: string | undefined,
    products: PosProductSnapshot[],
  ): Promise<PosProductSnapshot[]> {
    if (products.length === 0) return products;
    const rows = await this.dataSource.query<
      Array<{
        kit_product_id: string;
        stock_mode: 'DERIVED' | 'ASSEMBLED';
        price_rule: 'FIXED' | 'COMPONENT_SUM';
        component_product_id: string;
        component_name: string;
        component_sku: string;
        component_quantity: string;
        component_price: string;
        component_cost: string;
        component_available: string;
      }>
    >(
      `SELECT pk.product_id AS kit_product_id, pk.stock_mode, pk.price_rule,
              c.component_product_id, cp.name AS component_name,
              cp.sku AS component_sku, c.quantity AS component_quantity,
              cp.price AS component_price, cp.cost AS component_cost,
              COALESCE(SUM(CASE WHEN l.warehouse_id = ?
                THEN ib.available_quantity ELSE 0 END), 0) AS component_available
       FROM product_kits pk
       INNER JOIN product_kit_components c
         ON c.kit_product_id = pk.product_id AND c.tenant_id = pk.tenant_id
       INNER JOIN products cp
         ON cp.id = c.component_product_id AND cp.tenant_id = c.tenant_id
       LEFT JOIN inventory_balances ib
         ON ib.product_id = cp.id AND ib.tenant_id = cp.tenant_id
       LEFT JOIN locations l
         ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       WHERE pk.tenant_id = ?
         AND pk.product_id IN (${products.map(() => '?').join(',')})
         AND (pk.effective_from IS NULL OR pk.effective_from <= ?)
         AND (pk.effective_to IS NULL OR pk.effective_to >= ?)
       GROUP BY pk.product_id, pk.stock_mode, pk.price_rule,
                c.component_product_id, cp.name, cp.sku, c.quantity,
                cp.price, cp.cost, c.position
       ORDER BY pk.product_id, c.position, c.id`,
      [
        warehouseId,
        tenantId,
        ...products.map(({ id }) => id),
        currentDate ?? new Date().toISOString().slice(0, 10),
        currentDate ?? new Date().toISOString().slice(0, 10),
      ],
    );
    const byKit = new Map<string, typeof rows>();
    for (const row of rows) {
      byKit.set(row.kit_product_id, [
        ...(byKit.get(row.kit_product_id) ?? []),
        row,
      ]);
    }
    return products.map((product) => {
      const components = byKit.get(product.id);
      if (!components?.length) return product;
      let availableKitUnits: bigint | null = null;
      let componentPriceCents = 0n;
      for (const component of components) {
        const perKit = this.toUnits(component.component_quantity);
        const available = this.toUnits(component.component_available);
        const supported = (available / perKit) * 1000n;
        availableKitUnits =
          availableKitUnits === null || supported < availableKitUnits
            ? supported
            : availableKitUnits;
        componentPriceCents += this.roundDivide(
          this.toMoneyCents(component.component_price) * perKit,
          1000n,
        );
      }
      const definition = components[0];
      return {
        ...product,
        price:
          definition.price_rule === 'COMPONENT_SUM'
            ? this.fromMoneyCents(componentPriceCents)
            : product.price,
        availableQuantity:
          definition.stock_mode === 'DERIVED'
            ? this.fromUnits(availableKitUnits ?? 0n)
            : product.availableQuantity,
        kit: {
          stockMode: definition.stock_mode,
          priceRule: definition.price_rule,
          components: components.map((component) => ({
            product: {
              id: component.component_product_id,
              name: component.component_name,
              sku: component.component_sku,
            },
            quantity: this.normalizeQuantity(component.component_quantity),
            availableQuantity: this.normalizeQuantity(
              component.component_available,
            ),
            unitCost: this.normalizeCost(component.component_cost),
          })),
        },
      };
    });
  }

  async getSelectedLotAvailability(
    tenantId: string,
    warehouseId: string,
    selections: Array<{ productId: string; lotId: string }>,
  ): Promise<
    Map<
      string,
      {
        quantity: string;
        expiresOn: string | null;
        allowExpiredStockOverride: boolean;
      }
    >
  > {
    if (selections.length === 0) return new Map();
    const filters = selections.map(() => '(il.product_id = ? AND il.id = ?)');
    const parameters = selections.flatMap((item) => [
      item.productId,
      item.lotId,
    ]);
    const rows = await this.dataSource.query<
      Array<{
        product_id: string;
        lot_id: string;
        quantity: string;
        expires_on: string | Date | null;
        allow_expired_stock_override: number | boolean;
      }>
    >(
      `SELECT il.product_id, il.id AS lot_id, il.expires_on,
              p.allow_expired_stock_override,
              COALESCE(SUM(LEAST(ilb.quantity, COALESCE(ib.available_quantity, 0))), 0) AS quantity
       FROM inventory_lots il
       INNER JOIN products p ON p.id = il.product_id AND p.tenant_id = il.tenant_id
       LEFT JOIN inventory_lot_balances ilb
         ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
       LEFT JOIN locations l ON l.id = ilb.location_id AND l.tenant_id = ilb.tenant_id
       LEFT JOIN inventory_balances ib
         ON ib.tenant_id = ilb.tenant_id AND ib.product_id = il.product_id
        AND ib.location_id = ilb.location_id
       WHERE il.tenant_id = ? AND (${filters.join(' OR ')})
         AND (ilb.location_id IS NULL OR l.warehouse_id = ?)
       GROUP BY il.product_id, il.id, il.expires_on, p.allow_expired_stock_override`,
      [tenantId, ...parameters, warehouseId],
    );
    return new Map(
      rows.map((row) => [
        `${row.product_id}:${row.lot_id}`,
        {
          quantity: this.normalizeQuantity(row.quantity),
          expiresOn: row.expires_on
            ? row.expires_on instanceof Date
              ? row.expires_on.toISOString().slice(0, 10)
              : row.expires_on.slice(0, 10)
            : null,
          allowExpiredStockOverride: Boolean(row.allow_expired_stock_override),
        },
      ]),
    );
  }

  private async capExpiredLotAvailability(
    tenantId: string,
    warehouseId: string,
    currentDate: string | undefined,
    products: PosProductSnapshot[],
  ): Promise<PosProductSnapshot[]> {
    const tracked = products.filter((product) => product.trackLots);
    if (!currentDate || tracked.length === 0) return products;
    const rows = await this.dataSource.query<
      Array<{ product_id: string; quantity: string }>
    >(
      `SELECT il.product_id, COALESCE(SUM(ilb.quantity), 0) AS quantity
       FROM inventory_lots il
       INNER JOIN inventory_lot_balances ilb
         ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
       INNER JOIN locations l
         ON l.id = ilb.location_id AND l.tenant_id = ilb.tenant_id
       WHERE il.tenant_id = ? AND l.warehouse_id = ?
         AND il.product_id IN (${tracked.map(() => '?').join(', ')})
         AND (il.expires_on IS NULL OR il.expires_on >= ?)
       GROUP BY il.product_id`,
      [
        tenantId,
        warehouseId,
        ...tracked.map((product) => product.id),
        currentDate,
      ],
    );
    const usable = new Map(rows.map((row) => [row.product_id, row.quantity]));
    return products.map((product) => {
      if (!product.trackLots) return product;
      const available = this.toUnits(product.availableQuantity);
      const usableQuantity = this.toUnits(usable.get(product.id) ?? '0');
      return {
        ...product,
        availableQuantity: this.normalizeQuantity(
          this.fromUnits(
            available < usableQuantity ? available : usableQuantity,
          ),
        ),
      };
    });
  }

  private toUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  }

  private fromUnits(value: bigint): string {
    return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
  }

  private normalizeQuantity(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(3, '0').slice(0, 3)}`;
  }

  private toMoneyCents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  }

  private fromMoneyCents(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private roundDivide(value: bigint, divisor: bigint): bigint {
    return (value + divisor / 2n) / divisor;
  }

  private normalizeCost(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(4, '0').slice(0, 4)}`;
  }
}

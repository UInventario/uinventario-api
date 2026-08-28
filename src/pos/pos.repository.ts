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
    branch: { id: string; name: string };
    warehouse: { id: string; name: string };
    cashRegister: { id: string; name: string; code: string };
  }> {
    const rows = await this.dataSource.query<
      Array<{
        country_code: string;
        branch_id: string;
        branch_name: string;
        warehouse_id: string;
        warehouse_name: string;
        cash_register_id: string;
        cash_register_name: string;
        cash_register_code: string;
      }>
    >(
      `SELECT t.country_code, b.id AS branch_id, b.name AS branch_name,
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
  ): Promise<PosProductSnapshot[]> {
    const placeholders = productIds.map(() => '?').join(', ');
    if (reservationId) {
      const rows = await this.dataSource.query<
        Array<{
          id: string;
          name: string;
          sku: string;
          price: string;
          active: number | boolean;
          track_lots: number | boolean;
          track_serials: number | boolean;
          available_quantity: string;
        }>
      >(
        `SELECT p.id, p.name, p.sku, p.price, p.active, p.track_lots, p.track_serials,
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
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        sku: row.sku,
        price: row.price,
        active: Boolean(row.active),
        trackLots: Boolean(row.track_lots),
        trackSerials: Boolean(row.track_serials),
        availableQuantity: this.normalizeQuantity(row.available_quantity),
      }));
    }
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        name: string;
        sku: string;
        price: string;
        active: number | boolean;
        track_lots: number | boolean;
        track_serials: number | boolean;
        available_quantity: string;
      }>
    >(
      `SELECT p.id, p.name, p.sku, p.price, p.active, p.track_lots, p.track_serials,
              COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.available_quantity ELSE 0 END), 0) AS available_quantity
       FROM products p
       LEFT JOIN inventory_balances ib ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
       LEFT JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       WHERE p.tenant_id = ? AND p.id IN (${placeholders})
       GROUP BY p.id, p.name, p.sku, p.price, p.active, p.track_lots, p.track_serials`,
      [warehouseId, tenantId, ...productIds],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      price: row.price,
      active: Boolean(row.active),
      trackLots: Boolean(row.track_lots),
      trackSerials: Boolean(row.track_serials),
      availableQuantity: this.normalizeQuantity(row.available_quantity),
    }));
  }

  async getSelectedLotAvailability(
    tenantId: string,
    warehouseId: string,
    selections: Array<{ productId: string; lotId: string }>,
  ): Promise<Map<string, string>> {
    if (selections.length === 0) return new Map();
    const filters = selections.map(() => '(il.product_id = ? AND il.id = ?)');
    const parameters = selections.flatMap((item) => [
      item.productId,
      item.lotId,
    ]);
    const rows = await this.dataSource.query<
      Array<{ product_id: string; lot_id: string; quantity: string }>
    >(
      `SELECT il.product_id, il.id AS lot_id,
              COALESCE(SUM(LEAST(ilb.quantity, COALESCE(ib.available_quantity, 0))), 0) AS quantity
       FROM inventory_lots il
       LEFT JOIN inventory_lot_balances ilb
         ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
       LEFT JOIN locations l ON l.id = ilb.location_id AND l.tenant_id = ilb.tenant_id
       LEFT JOIN inventory_balances ib
         ON ib.tenant_id = ilb.tenant_id AND ib.product_id = il.product_id
        AND ib.location_id = ilb.location_id
       WHERE il.tenant_id = ? AND (${filters.join(' OR ')})
         AND (ilb.location_id IS NULL OR l.warehouse_id = ?)
       GROUP BY il.product_id, il.id`,
      [tenantId, ...parameters, warehouseId],
    );
    return new Map(
      rows.map((row) => [
        `${row.product_id}:${row.lot_id}`,
        this.normalizeQuantity(row.quantity),
      ]),
    );
  }

  private normalizeQuantity(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(3, '0').slice(0, 3)}`;
  }
}

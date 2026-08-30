import { Injectable } from '@nestjs/common';
import { quantityFromUnits, quantityToUnits } from '../common/quantity-policy';
import { DataSource } from 'typeorm';
import type {
  InventoryActivityMovementsDto,
  InventoryActivityReportDto,
} from './dto/inventory-activity-report.dto';

export interface BranchScope {
  id: string;
  name: string;
  timezone: string;
}

interface ActivityRow {
  product_id: string;
  product_name: string;
  product_sku: string;
  category_id: string | null;
  category_name: string | null;
  opening_quantity: string;
  closing_quantity: string;
  net_sold_quantity: string;
  loss_quantity: string;
  activity_quantity: string;
  last_movement_at: Date | string | null;
}

@Injectable()
export class InventoryActivityReportRepository {
  constructor(private readonly dataSource: DataSource) {}

  async report(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: InventoryActivityReportDto;
  }) {
    const authorizedBranches = await this.authorizedBranches(input);
    const branches = input.query.branchId
      ? authorizedBranches.filter(({ id }) => id === input.query.branchId)
      : authorizedBranches;
    if (branches.length === 0) return null;

    const base = this.baseFilter(input.tenantId, branches, input.query);
    const ranges = this.rangeTable(
      branches,
      input.query.dateFrom,
      input.query.dateTo,
    );
    const offset = (input.query.page - 1) * input.query.pageSize;
    const [rows, count, categories, warehouses] = await Promise.all([
      this.dataSource.query<ActivityRow[]>(
        `SELECT p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
                c.id AS category_id, c.name AS category_name,
                COALESCE(SUM(CASE
                  WHEN period_scope.start_at IS NOT NULL
                    AND im.created_at < period_scope.start_at
                  THEN im.quantity_change ELSE 0 END), 0) AS opening_quantity,
                COALESCE(SUM(im.quantity_change), 0) AS closing_quantity,
                COALESCE(SUM(CASE
                  WHEN (period_scope.start_at IS NULL OR im.created_at >= period_scope.start_at)
                    AND im.type IN ('SALE', 'SALE_VOID', 'SALE_RETURN')
                  THEN -im.quantity_change ELSE 0 END), 0) AS net_sold_quantity,
                COALESCE(SUM(CASE
                  WHEN (period_scope.start_at IS NULL OR im.created_at >= period_scope.start_at)
                    AND im.type IN ('LOSS', 'DAMAGE') AND im.quantity_change < 0
                  THEN -im.quantity_change ELSE 0 END), 0) AS loss_quantity,
                COALESCE(SUM(CASE
                  WHEN period_scope.start_at IS NULL OR im.created_at >= period_scope.start_at
                  THEN ABS(im.quantity_change) ELSE 0 END), 0) AS activity_quantity,
                MAX(CASE WHEN period_scope.start_at IS NULL
                  OR im.created_at >= period_scope.start_at THEN im.created_at END)
                  AS last_movement_at
         FROM inventory_balances ib
         INNER JOIN products p ON p.id = ib.product_id AND p.tenant_id = ib.tenant_id
         LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
         INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
         INNER JOIN (${ranges.sql}) period_scope ON period_scope.id = b.id
         LEFT JOIN inventory_movements im
           ON im.tenant_id = ib.tenant_id AND im.product_id = ib.product_id
             AND im.location_id = ib.location_id
             AND (period_scope.end_at IS NULL OR im.created_at < period_scope.end_at)
         WHERE ${base.sql}
         GROUP BY p.id, p.name, p.sku, c.id, c.name
         ORDER BY CASE WHEN COALESCE(SUM(CASE
                    WHEN (period_scope.start_at IS NULL OR im.created_at >= period_scope.start_at)
                      AND im.type IN ('SALE', 'SALE_VOID', 'SALE_RETURN')
                    THEN -im.quantity_change ELSE 0 END), 0) <= 0
                   AND COALESCE(SUM(im.quantity_change), 0) > 0 THEN 0 ELSE 1 END,
                  net_sold_quantity ASC, p.name, p.id
         LIMIT ? OFFSET ?`,
        [
          ...ranges.parameters,
          ...base.parameters,
          input.query.pageSize,
          offset,
        ],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(DISTINCT p.id) AS total
         FROM inventory_balances ib
         INNER JOIN products p ON p.id = ib.product_id AND p.tenant_id = ib.tenant_id
         LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
         INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
         WHERE ${base.sql}`,
        base.parameters,
      ),
      this.dataSource.query<Array<{ id: string; name: string }>>(
        `SELECT c.id, c.name FROM categories c
         WHERE c.tenant_id = ? AND c.active = TRUE ORDER BY c.name, c.id`,
        [input.tenantId],
      ),
      this.warehouses(input.tenantId, authorizedBranches),
    ]);

    return {
      period: {
        dateFrom: input.query.dateFrom ?? null,
        dateTo: input.query.dateTo ?? null,
        timezone: 'BRANCH_LOCAL' as const,
      },
      scope: {
        branches: authorizedBranches,
        warehouses: warehouses.map((warehouse) => ({
          id: warehouse.id,
          name: warehouse.name,
          branch: { id: warehouse.branch_id, name: warehouse.branch_name },
        })),
      },
      filters: { categories },
      definitions: {
        rotation:
          'Ventas netas del período / stock promedio simple de apertura y cierre. Un valor 1 equivale a una rotación completa.',
        loss: 'Unidades descontadas mediante movimientos explícitos LOSS o DAMAGE durante el período.',
        period:
          'Días calendario completos en la zona horaria de cada sucursal. Sin fechas se usa todo el historial.',
        returnsAndVoids:
          'SALE_RETURN y SALE_VOID restauran unidades y reducen las ventas netas; no cuentan como una venta nueva.',
        transfers:
          'Las transferencias cuentan como actividad, pero no como venta ni pérdida.',
      },
      items: rows.map((row) => this.mapRow(row)),
      total: Number(count[0]?.total ?? 0),
    };
  }

  async movements(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    productId: string;
    query: InventoryActivityMovementsDto;
  }) {
    const authorizedBranches = await this.authorizedBranches(input);
    const branches = input.query.branchId
      ? authorizedBranches.filter(({ id }) => id === input.query.branchId)
      : authorizedBranches;
    if (branches.length === 0) return null;
    const ranges = this.rangeTable(
      branches,
      input.query.dateFrom,
      input.query.dateTo,
    );
    const warehouseSql = input.query.warehouseId ? 'AND w.id = ?' : '';
    const warehouseParameters = input.query.warehouseId
      ? [input.query.warehouseId]
      : [];
    const offset = (input.query.page - 1) * input.query.pageSize;
    const commonParameters = [
      ...ranges.parameters,
      input.tenantId,
      input.productId,
      ...warehouseParameters,
    ];
    const [rows, count] = await Promise.all([
      this.dataSource.query<
        Array<{
          id: string;
          type: string;
          quantity_change: string;
          resulting_quantity: string;
          reason: string;
          reference: string | null;
          created_at: Date | string;
          branch_name: string;
          warehouse_name: string;
          location_name: string;
        }>
      >(
        `SELECT im.id, im.type, im.quantity_change, im.resulting_quantity,
                im.reason, im.reference, im.created_at, b.name AS branch_name,
                w.name AS warehouse_name, l.name AS location_name
         FROM inventory_movements im
         INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
         INNER JOIN (${ranges.sql}) period_scope ON period_scope.id = b.id
         WHERE im.tenant_id = ? AND im.product_id = ? ${warehouseSql}
           AND (period_scope.start_at IS NULL OR im.created_at >= period_scope.start_at)
           AND (period_scope.end_at IS NULL OR im.created_at < period_scope.end_at)
         ORDER BY im.created_at DESC, im.id DESC LIMIT ? OFFSET ?`,
        [...commonParameters, input.query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM inventory_movements im
         INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
         INNER JOIN (${ranges.sql}) period_scope ON period_scope.id = b.id
         WHERE im.tenant_id = ? AND im.product_id = ? ${warehouseSql}
           AND (period_scope.start_at IS NULL OR im.created_at >= period_scope.start_at)
           AND (period_scope.end_at IS NULL OR im.created_at < period_scope.end_at)`,
        commonParameters,
      ),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        quantityChange: this.quantity(row.quantity_change),
        resultingQuantity: this.quantity(row.resulting_quantity),
        reason: row.reason,
        reference: row.reference,
        occurredAt: new Date(row.created_at).toISOString(),
        branchName: row.branch_name,
        warehouseName: row.warehouse_name,
        locationName: row.location_name,
      })),
      total: Number(count[0]?.total ?? 0),
    };
  }

  private async authorizedBranches(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
  }): Promise<BranchScope[]> {
    return this.dataSource.query<BranchScope[]>(
      `SELECT b.id, b.name, b.timezone FROM branches b
       WHERE b.tenant_id = ? AND b.active = TRUE
         AND (? = TRUE OR EXISTS (SELECT 1 FROM user_branch_access uba
           WHERE uba.tenant_id = b.tenant_id AND uba.branch_id = b.id
             AND uba.user_id = ?))
       ORDER BY b.name, b.id`,
      [input.tenantId, input.administrator, input.userId],
    );
  }

  private async warehouses(tenantId: string, branches: BranchScope[]) {
    const placeholders = branches.map(() => '?').join(', ');
    return this.dataSource.query<
      Array<{
        id: string;
        name: string;
        branch_id: string;
        branch_name: string;
      }>
    >(
      `SELECT w.id, w.name, w.branch_id, b.name AS branch_name
       FROM warehouses w INNER JOIN branches b
         ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
       WHERE w.tenant_id = ? AND w.active = TRUE AND w.branch_id IN (${placeholders})
       ORDER BY b.name, w.name, w.id`,
      [tenantId, ...branches.map(({ id }) => id)],
    );
  }

  private baseFilter(
    tenantId: string,
    branches: BranchScope[],
    query: InventoryActivityReportDto,
  ) {
    const filters = [
      'ib.tenant_id = ?',
      `b.id IN (${branches.map(() => '?').join(', ')})`,
    ];
    const parameters: unknown[] = [tenantId, ...branches.map(({ id }) => id)];
    if (query.warehouseId) {
      filters.push('w.id = ?');
      parameters.push(query.warehouseId);
    }
    if (query.categoryId) {
      filters.push('p.category_id = ?');
      parameters.push(query.categoryId);
    }
    if (query.product) {
      filters.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)');
      const pattern = `%${query.product.replace(/[\\%_]/g, '\\$&')}%`;
      parameters.push(pattern, pattern, pattern);
    }
    return { sql: filters.join(' AND '), parameters };
  }

  private rangeTable(
    branches: BranchScope[],
    dateFrom?: string,
    dateTo?: string,
  ) {
    const parameters: unknown[] = [];
    const rows = branches.map((branch) => {
      parameters.push(
        branch.id,
        dateFrom ? this.localBoundary(dateFrom, branch.timezone, 0) : null,
        dateTo ? this.localBoundary(dateTo, branch.timezone, 1) : null,
      );
      return 'SELECT ? AS id, ? AS start_at, ? AS end_at';
    });
    return { sql: rows.join(' UNION ALL '), parameters };
  }

  private mapRow(row: ActivityRow) {
    const opening = quantityToUnits(row.opening_quantity);
    const closing = quantityToUnits(row.closing_quantity);
    const netSold = quantityToUnits(row.net_sold_quantity);
    const average = (opening + closing + 1n) / 2n;
    const rotationUnits =
      average > 0n ? (netSold * 10_000n + average / 2n) / average : null;
    return {
      product: {
        id: row.product_id,
        name: row.product_name,
        sku: row.product_sku,
        category: row.category_id
          ? { id: row.category_id, name: row.category_name! }
          : null,
      },
      openingQuantity: this.quantity(row.opening_quantity),
      closingQuantity: this.quantity(row.closing_quantity),
      averageQuantity: quantityFromUnits(average),
      netSoldQuantity: this.quantity(row.net_sold_quantity),
      lossQuantity: this.quantity(row.loss_quantity),
      activityQuantity: this.quantity(row.activity_quantity),
      rotation: rotationUnits === null ? null : Number(rotationUnits) / 10_000,
      status:
        closing > 0n && netSold <= 0n ? ('SLOW' as const) : ('ACTIVE' as const),
      lastMovementAt: row.last_movement_at
        ? new Date(row.last_movement_at).toISOString()
        : null,
    };
  }

  private localBoundary(
    date: string,
    timezone: string,
    addDays: number,
  ): string {
    const [year, month, day] = date.split('-').map(Number);
    const target = Date.UTC(year, month - 1, day + addDays);
    let instant = target;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(instant))
          .map((part) => [part.type, part.value]),
      );
      const represented = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      instant += target - represented;
    }
    return new Date(instant).toISOString().slice(0, 23).replace('T', ' ');
  }

  private quantity(value: string): string {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric.toFixed(3) : '0.000';
  }
}

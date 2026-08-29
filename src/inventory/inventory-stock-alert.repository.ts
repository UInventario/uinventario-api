import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ListStockAlertsDto } from './dto/list-stock-alerts.dto';
import { InventoryTargetNotFoundError } from './inventory.errors';
import type { InventoryStockAlertData } from './inventory-stock-alert.types';

interface AlertRow {
  product_id: string;
  product_name: string;
  product_sku: string;
  location_id: string;
  location_name: string;
  location_code: string;
  status: InventoryStockAlertData['status'];
  available_quantity: string;
  low_stock_threshold: string;
  transitioned_at: Date | string;
}

@Injectable()
export class InventoryStockAlertRepository {
  constructor(private readonly dataSource: DataSource) {}

  async reconcileTenant(tenantId: string): Promise<void> {
    const warehouses = await this.dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM warehouses WHERE tenant_id = ? AND active = TRUE',
      [tenantId],
    );
    for (const warehouse of warehouses) {
      await this.reconcile(tenantId, warehouse.id);
    }
  }

  async list(
    tenantId: string,
    branchId: string,
    warehouseId: string,
    query: ListStockAlertsDto,
  ): Promise<{
    items: InventoryStockAlertData[];
    total: number;
    scope: {
      branch: { id: string; name: string };
      warehouse: { id: string; name: string };
    };
  }> {
    await this.reconcile(tenantId, warehouseId);
    const [scope] = await this.dataSource.query<
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
    if (!scope) throw new InventoryTargetNotFoundError();

    const filters = [
      'alert.tenant_id = ?',
      'location.warehouse_id = ?',
      "alert.status <> 'HEALTHY'",
    ];
    const parameters: unknown[] = [tenantId, warehouseId];
    if (query.status) {
      filters.push('alert.status = ?');
      parameters.push(query.status);
    }
    if (query.q) {
      const search = `%${query.q}%`;
      filters.push(
        '(product.name LIKE ? OR product.normalized_sku LIKE ? OR location.name LIKE ? OR location.code LIKE ?)',
      );
      parameters.push(
        search,
        search.toUpperCase(),
        search,
        search.toUpperCase(),
      );
    }
    const where = filters.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<AlertRow[]>(
        `SELECT product.id AS product_id, product.name AS product_name,
                product.sku AS product_sku, location.id AS location_id,
                location.name AS location_name, location.code AS location_code,
                alert.status, alert.available_quantity,
                alert.low_stock_threshold, alert.transitioned_at
         FROM inventory_stock_alert_states alert
         INNER JOIN products product
           ON product.id = alert.product_id AND product.tenant_id = alert.tenant_id
         INNER JOIN locations location
           ON location.id = alert.location_id AND location.tenant_id = alert.tenant_id
         WHERE ${where} AND product.active = TRUE AND location.active = TRUE
         ORDER BY FIELD(alert.status, 'OUT_OF_STOCK', 'LOW', 'RECOVERED'),
                  alert.transitioned_at DESC, product.name, location.name
         LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total
         FROM inventory_stock_alert_states alert
         INNER JOIN products product
           ON product.id = alert.product_id AND product.tenant_id = alert.tenant_id
         INNER JOIN locations location
           ON location.id = alert.location_id AND location.tenant_id = alert.tenant_id
         WHERE ${where} AND product.active = TRUE AND location.active = TRUE`,
        parameters,
      ),
    ]);
    return {
      items: rows.map((row) => this.toData(row)),
      total: Number(countRows[0]?.total ?? 0),
      scope: {
        branch: { id: scope.branch_id, name: scope.branch_name },
        warehouse: { id: scope.warehouse_id, name: scope.warehouse_name },
      },
    };
  }

  async setThreshold(input: {
    tenantId: string;
    warehouseId: string;
    productId: string;
    locationId: string;
    threshold: string;
  }): Promise<InventoryStockAlertData> {
    return this.dataSource.transaction(async (manager) => {
      const [target] = await manager.query<Array<{ found: number }>>(
        `SELECT 1 AS found FROM products product
         INNER JOIN locations location
           ON location.id = ? AND location.tenant_id = product.tenant_id
          AND location.warehouse_id = ? AND location.active = TRUE
         WHERE product.id = ? AND product.tenant_id = ? AND product.active = TRUE LIMIT 1`,
        [input.locationId, input.warehouseId, input.productId, input.tenantId],
      );
      if (!target) throw new InventoryTargetNotFoundError();
      await manager.query(
        `INSERT INTO inventory_stock_thresholds
           (tenant_id, product_id, location_id, low_stock_threshold)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE low_stock_threshold = VALUES(low_stock_threshold)`,
        [input.tenantId, input.productId, input.locationId, input.threshold],
      );
      await manager.query(
        `INSERT INTO inventory_balances
           (tenant_id, product_id, location_id, quantity)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE available_quantity = available_quantity`,
        [input.tenantId, input.productId, input.locationId],
      );
      await this.reconcile(
        input.tenantId,
        input.warehouseId,
        input.productId,
        input.locationId,
        manager,
      );
      const [row] = await manager.query<AlertRow[]>(
        `SELECT product.id AS product_id, product.name AS product_name,
                product.sku AS product_sku, location.id AS location_id,
                location.name AS location_name, location.code AS location_code,
                alert.status, alert.available_quantity,
                alert.low_stock_threshold, alert.transitioned_at
         FROM inventory_stock_alert_states alert
         INNER JOIN products product
           ON product.id = alert.product_id AND product.tenant_id = alert.tenant_id
         INNER JOIN locations location
           ON location.id = alert.location_id AND location.tenant_id = alert.tenant_id
         WHERE alert.tenant_id = ? AND alert.product_id = ? AND alert.location_id = ? LIMIT 1`,
        [input.tenantId, input.productId, input.locationId],
      );
      if (!row) throw new InventoryTargetNotFoundError();
      return this.toData(row);
    });
  }

  private async reconcile(
    tenantId: string,
    warehouseId: string,
    productId?: string,
    locationId?: string,
    executor: Pick<DataSource, 'query'> = this.dataSource,
  ): Promise<void> {
    const targetFilter = productId
      ? 'AND balance.product_id = ? AND balance.location_id = ?'
      : '';
    const parameters = productId
      ? [tenantId, warehouseId, productId, locationId]
      : [tenantId, warehouseId];
    await executor.query(
      `INSERT INTO inventory_stock_alert_states
         (tenant_id, product_id, location_id, status, available_quantity,
          low_stock_threshold, transitioned_at)
       SELECT balance.tenant_id, balance.product_id, balance.location_id,
              CASE
                WHEN balance.available_quantity > COALESCE(threshold.low_stock_threshold, 5)
                  AND current_alert.status IN ('LOW', 'OUT_OF_STOCK') THEN 'RECOVERED'
                WHEN balance.available_quantity > COALESCE(threshold.low_stock_threshold, 5)
                  AND current_alert.status = 'RECOVERED' THEN 'RECOVERED'
                WHEN balance.available_quantity <= 0 THEN 'OUT_OF_STOCK'
                WHEN balance.available_quantity <= COALESCE(threshold.low_stock_threshold, 5)
                  THEN 'LOW'
                ELSE 'HEALTHY'
              END,
              balance.available_quantity,
              COALESCE(threshold.low_stock_threshold, 5),
              COALESCE(current_alert.transitioned_at, CURRENT_TIMESTAMP(6))
       FROM inventory_balances balance
       INNER JOIN locations location
         ON location.id = balance.location_id AND location.tenant_id = balance.tenant_id
       LEFT JOIN inventory_stock_thresholds threshold
         ON threshold.tenant_id = balance.tenant_id
        AND threshold.product_id = balance.product_id
        AND threshold.location_id = balance.location_id
       LEFT JOIN inventory_stock_alert_states current_alert
         ON current_alert.tenant_id = balance.tenant_id
        AND current_alert.product_id = balance.product_id
        AND current_alert.location_id = balance.location_id
       WHERE balance.tenant_id = ? AND location.warehouse_id = ? ${targetFilter}
       ON DUPLICATE KEY UPDATE
         transitioned_at = IF(
           inventory_stock_alert_states.status <> VALUES(status),
           CURRENT_TIMESTAMP(6),
           inventory_stock_alert_states.transitioned_at
         ),
         status = VALUES(status),
         available_quantity = VALUES(available_quantity),
         low_stock_threshold = VALUES(low_stock_threshold)`,
      parameters,
    );
  }

  private toData(row: AlertRow): InventoryStockAlertData {
    return {
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
      status: row.status,
      availableQuantity: Number(row.available_quantity).toFixed(3),
      threshold: Number(row.low_stock_threshold).toFixed(3),
      transitionedAt: new Date(row.transitioned_at).toISOString(),
    };
  }
}

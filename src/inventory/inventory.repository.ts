import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  normalizeProductQuantity,
  ProductBaseUnit,
  ProductQuantityPolicy,
  QuantityRoundingMode,
} from '../common/quantity-policy';
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
  InventoryCountConflictError,
  MovementReferenceRequiredError,
} from './inventory.errors';
import {
  InventoryBalanceData,
  InventoryCountData,
  InventoryCountInput,
  InventoryLocationData,
  InventoryMovementType,
  InventoryStockState,
  InventoryMovementHistoryItem,
  InventoryMovementData,
  InventoryStockItem,
  InventoryLotData,
  InventoryLotExpirationAlertData,
  InventoryLotAllocation,
  InventoryFifoLayerData,
  InventoryFifoAllocation,
  InventorySerialData,
  InventorySerialEventData,
} from './inventory.types';
import { applyInventoryValuation } from './inventory-valuation';
import { applyInventoryLotTracking } from './inventory-lot-tracking';
import { applyInventorySerialTracking } from './inventory-serial-tracking';
import type { InventoryValuationMethod } from './inventory-valuation-policy.types';

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
  unit_cost: string | null;
  value_change: string | null;
  resulting_inventory_value: string | null;
  average_unit_cost: string | null;
  valuation_method: import('./inventory-valuation-policy.types').InventoryValuationMethod;
  valuation_policy_version: number | string;
  valuation_effective_at: Date | string;
  fifo_unit_cost: string | null;
  fifo_value_change: string | null;
  fifo_resulting_inventory_value: string | null;
}

interface CountRow {
  id: string;
  snapshot_quantity: string;
  counted_quantity: string;
  variance_quantity: string;
  reason: string;
  reference: string;
  device_captured_at: Date | string;
  created_at: Date | string;
  movement_id: string | null;
  request_fingerprint: string;
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
       WHERE tenant_id = ? AND warehouse_id = ? AND active = TRUE ORDER BY name, id`,
      [tenantId, warehouseId],
    );
  }

  async listSerials(
    tenantId: string,
    warehouseId: string,
    productId: string,
  ): Promise<{ items: InventorySerialData[]; tracked: boolean }> {
    const [product] = await this.dataSource.query<
      Array<{ id: string; name: string; sku: string; track_serials: boolean }>
    >(
      `SELECT id, name, sku, track_serials FROM products
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [productId, tenantId],
    );
    if (!product) throw new InventoryTargetNotFoundError();
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        serial_number: string;
        status: InventorySerialData['status'];
        created_at: Date | string;
        updated_at: Date | string;
        location_id: string | null;
        location_name: string | null;
        location_code: string | null;
      }>
    >(
      `SELECT serial.id, serial.serial_number, serial.status,
              serial.created_at, serial.updated_at,
              location.id AS location_id, location.name AS location_name,
              location.code AS location_code
       FROM inventory_serials serial
       LEFT JOIN locations location
         ON location.id = serial.current_location_id
        AND location.tenant_id = serial.tenant_id
       WHERE serial.tenant_id = ? AND serial.product_id = ?
         AND (
           location.warehouse_id = ? OR EXISTS (
             SELECT 1 FROM inventory_serial_events event
             LEFT JOIN locations source_location
               ON source_location.id = event.from_location_id
              AND source_location.tenant_id = event.tenant_id
             LEFT JOIN locations target_location
               ON target_location.id = event.to_location_id
              AND target_location.tenant_id = event.tenant_id
             WHERE event.tenant_id = serial.tenant_id
               AND event.serial_id = serial.id
               AND (source_location.warehouse_id = ? OR target_location.warehouse_id = ?)
           )
         )
       ORDER BY serial.updated_at DESC, serial.normalized_serial
       LIMIT 500`,
      [tenantId, productId, warehouseId, warehouseId, warehouseId],
    );
    return {
      tracked: Boolean(product.track_serials),
      items: rows.map((row) => ({
        id: row.id,
        serialNumber: row.serial_number,
        status: row.status,
        product: { id: product.id, name: product.name, sku: product.sku },
        currentLocation:
          row.location_id && row.location_name && row.location_code
            ? {
                id: row.location_id,
                name: row.location_name,
                code: row.location_code,
              }
            : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    };
  }

  async serialHistory(
    tenantId: string,
    warehouseId: string,
    serialId: string,
  ): Promise<{
    serial: InventorySerialData;
    events: InventorySerialEventData[];
  }> {
    const [header] = await this.dataSource.query<Array<{ product_id: string }>>(
      `SELECT serial.product_id FROM inventory_serials serial
       WHERE serial.id = ? AND serial.tenant_id = ?
         AND EXISTS (
           SELECT 1 FROM inventory_serial_events event
           LEFT JOIN locations source_location
             ON source_location.id = event.from_location_id
            AND source_location.tenant_id = event.tenant_id
           LEFT JOIN locations target_location
             ON target_location.id = event.to_location_id
            AND target_location.tenant_id = event.tenant_id
           WHERE event.serial_id = serial.id AND event.tenant_id = serial.tenant_id
             AND (source_location.warehouse_id = ? OR target_location.warehouse_id = ?)
         ) LIMIT 1`,
      [serialId, tenantId, warehouseId, warehouseId],
    );
    if (!header) throw new InventoryTargetNotFoundError();
    const listed = await this.listSerials(
      tenantId,
      warehouseId,
      header.product_id,
    );
    const serial = listed.items.find((item) => item.id === serialId);
    if (!serial) throw new InventoryTargetNotFoundError();
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        from_status: InventorySerialData['status'] | null;
        to_status: InventorySerialData['status'];
        created_at: Date | string;
        movement_id: string;
        movement_type: InventoryMovementType;
        reference: string | null;
        reason: string;
        from_location_id: string | null;
        from_location_name: string | null;
        from_location_code: string | null;
        to_location_id: string | null;
        to_location_name: string | null;
        to_location_code: string | null;
        user_id: string;
        user_email: string;
      }>
    >(
      `SELECT event.id, event.from_status, event.to_status, event.created_at,
              movement.id AS movement_id, movement.type AS movement_type,
              movement.reference, movement.reason,
              source.id AS from_location_id, source.name AS from_location_name,
              source.code AS from_location_code,
              target.id AS to_location_id, target.name AS to_location_name,
              target.code AS to_location_code,
              user.id AS user_id, user.email AS user_email
       FROM inventory_serial_events event
       INNER JOIN inventory_movements movement ON movement.id = event.movement_id
       INNER JOIN users user
         ON user.id = event.created_by_user_id AND user.tenant_id = event.tenant_id
       LEFT JOIN locations source
         ON source.id = event.from_location_id AND source.tenant_id = event.tenant_id
       LEFT JOIN locations target
         ON target.id = event.to_location_id AND target.tenant_id = event.tenant_id
       WHERE event.tenant_id = ? AND event.serial_id = ?
       ORDER BY event.created_at, event.id`,
      [tenantId, serialId],
    );
    const location = (
      id: string | null,
      name: string | null,
      code: string | null,
    ) => (id && name && code ? { id, name, code } : null);
    return {
      serial,
      events: rows.map((row) => ({
        id: row.id,
        movement: {
          id: row.movement_id,
          type: row.movement_type,
          reference: row.reference,
          reason: row.reason,
        },
        fromStatus: row.from_status,
        toStatus: row.to_status,
        fromLocation: location(
          row.from_location_id,
          row.from_location_name,
          row.from_location_code,
        ),
        toLocation: location(
          row.to_location_id,
          row.to_location_name,
          row.to_location_code,
        ),
        responsible: { id: row.user_id, email: row.user_email },
        createdAt: new Date(row.created_at).toISOString(),
      })),
    };
  }

  async listLots(
    tenantId: string,
    warehouseId: string,
    productId: string,
  ): Promise<{
    items: InventoryLotData[];
    tracked: boolean;
    totalQuantity: string;
    lotQuantity: string;
    currency: string | null;
    inventoryValue: string;
  }> {
    const [scope] = await this.dataSource.query<Array<{ timezone: string }>>(
      `SELECT b.timezone FROM warehouses w
       INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
       WHERE w.id = ? AND w.tenant_id = ? LIMIT 1`,
      [warehouseId, tenantId],
    );
    if (!scope) throw new InventoryTargetNotFoundError();
    const businessDate = this.localDate(scope.timezone);
    const [product] = await this.dataSource.query<
      Array<{
        id: string;
        name: string;
        sku: string;
        track_lots: number | boolean;
        lot_expiration_alert_days: number;
        total_quantity: string;
      }>
    >(
      `SELECT p.id, p.name, p.sku, p.track_lots,
              p.lot_expiration_alert_days,
              COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.quantity ELSE 0 END), 0) AS total_quantity
       FROM products p
       LEFT JOIN inventory_balances ib
         ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
       LEFT JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       WHERE p.id = ? AND p.tenant_id = ?
       GROUP BY p.id, p.name, p.sku, p.track_lots,
                p.lot_expiration_alert_days`,
      [warehouseId, productId, tenantId],
    );
    if (!product) throw new InventoryTargetNotFoundError();
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        code: string;
        unit_cost: string;
        currency: string;
        manufactured_on: string | Date | null;
        expires_on: string | Date | null;
        created_at: Date | string;
        location_id: string | null;
        location_name: string | null;
        location_code: string | null;
        quantity: string | null;
      }>
    >(
      `SELECT il.id, il.code, il.unit_cost, il.currency,
              il.manufactured_on, il.expires_on, il.created_at,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              ilb.quantity
       FROM inventory_lots il
       LEFT JOIN inventory_lot_balances ilb
         ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
       LEFT JOIN locations l ON l.id = ilb.location_id AND l.tenant_id = ilb.tenant_id
         AND l.warehouse_id = ?
       WHERE il.tenant_id = ? AND il.product_id = ?
         AND (ilb.location_id IS NULL OR l.id IS NOT NULL)
       ORDER BY il.expires_on IS NULL, il.expires_on, il.created_at, il.id,
                l.created_at, l.id`,
      [warehouseId, tenantId, productId],
    );
    const lots = new Map<string, InventoryLotData>();
    for (const row of rows) {
      let lot = lots.get(row.id);
      if (!lot) {
        lot = {
          id: row.id,
          code: row.code,
          product: { id: product.id, name: product.name, sku: product.sku },
          quantity: '0.000',
          unitCost: this.normalizeCost(row.unit_cost),
          currency: row.currency,
          inventoryValue: '0.0000',
          manufacturedOn: this.dateOnly(row.manufactured_on),
          expiresOn: this.dateOnly(row.expires_on),
          expirationStatus: 'NO_EXPIRATION',
          daysUntilExpiration: null,
          createdAt: new Date(row.created_at).toISOString(),
          origins: [],
          balances: [],
        };
        lots.set(row.id, lot);
      }
      if (row.location_id && row.quantity !== null) {
        const quantity = this.normalizeDecimal(row.quantity);
        lot.balances.push({
          location: {
            id: row.location_id,
            name: row.location_name!,
            code: row.location_code!,
          },
          quantity,
        });
        lot.quantity = this.fromUnits(
          this.toUnits(lot.quantity) + this.toUnits(quantity),
        );
      }
    }
    const items = [...lots.values()];
    if (items.length > 0) {
      const origins = await this.dataSource.query<
        Array<{
          lot_id: string;
          purchase_receipt_line_id: string;
          quantity: string;
          unit_cost: string;
          currency: string;
          receipt_id: string;
          document_reference: string;
          purchase_order_id: string;
          folio: string;
        }>
      >(
        `SELECT ilo.lot_id, ilo.purchase_receipt_line_id, ilo.quantity,
                ilo.unit_cost, ilo.currency, pr.id AS receipt_id,
                pr.document_reference, po.id AS purchase_order_id, po.folio
         FROM inventory_lot_origins ilo
         INNER JOIN purchase_receipt_lines prl
           ON prl.id = ilo.purchase_receipt_line_id AND prl.tenant_id = ilo.tenant_id
         INNER JOIN purchase_receipts pr
           ON pr.id = prl.receipt_id AND pr.tenant_id = prl.tenant_id
         INNER JOIN purchase_orders po
           ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
         WHERE ilo.tenant_id = ? AND ilo.lot_id IN (${items.map(() => '?').join(', ')})
         ORDER BY ilo.created_at, ilo.purchase_receipt_line_id`,
        [tenantId, ...items.map((item) => item.id)],
      );
      for (const origin of origins) {
        lots.get(origin.lot_id)?.origins.push({
          purchaseReceiptLineId: origin.purchase_receipt_line_id,
          quantity: this.normalizeDecimal(origin.quantity),
          unitCost: this.normalizeCost(origin.unit_cost),
          currency: origin.currency,
          receipt: {
            id: origin.receipt_id,
            documentReference: origin.document_reference,
          },
          purchaseOrder: {
            id: origin.purchase_order_id,
            folio: origin.folio,
          },
        });
      }
    }
    for (const item of items) {
      item.inventoryValue = this.valuationValue(item.quantity, item.unitCost);
      item.daysUntilExpiration = item.expiresOn
        ? this.daysBetween(businessDate, item.expiresOn)
        : null;
      item.expirationStatus =
        this.toUnits(item.quantity) === 0n
          ? 'EXHAUSTED'
          : item.daysUntilExpiration === null
            ? 'NO_EXPIRATION'
            : item.daysUntilExpiration < 0
              ? 'EXPIRED'
              : item.daysUntilExpiration <= product.lot_expiration_alert_days
                ? 'EXPIRING'
                : 'ACTIVE';
    }
    const lotQuantity = this.fromUnits(
      items.reduce((sum, lot) => sum + this.toUnits(lot.quantity), 0n),
    );
    const currencies = new Set(items.map((item) => item.currency));
    const inventoryValue = this.fromCostUnits(
      items.reduce(
        (sum, item) => sum + this.toCostUnits(item.inventoryValue),
        0n,
      ),
    );
    return {
      items,
      tracked: Boolean(product.track_lots),
      totalQuantity: this.normalizeDecimal(product.total_quantity),
      lotQuantity,
      currency: currencies.size === 1 ? items[0].currency : null,
      inventoryValue,
    };
  }

  async listLotExpirationAlerts(
    tenantId: string,
    warehouseId: string,
  ): Promise<{
    items: InventoryLotExpirationAlertData[];
    businessDate: string;
  }> {
    const [scope] = await this.dataSource.query<Array<{ timezone: string }>>(
      `SELECT b.timezone FROM warehouses w
       INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
       WHERE w.id = ? AND w.tenant_id = ? LIMIT 1`,
      [warehouseId, tenantId],
    );
    if (!scope) throw new InventoryTargetNotFoundError();
    const businessDate = this.localDate(scope.timezone);
    const rows = await this.dataSource.query<
      Array<{
        lot_id: string;
        lot_code: string;
        expires_on: string | Date;
        product_id: string;
        product_name: string;
        product_sku: string;
        location_id: string;
        location_name: string;
        location_code: string;
        quantity: string;
      }>
    >(
      `SELECT il.id AS lot_id, il.code AS lot_code, il.expires_on,
              p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              ilb.quantity
       FROM inventory_lots il
       INNER JOIN products p ON p.id = il.product_id AND p.tenant_id = il.tenant_id
       INNER JOIN inventory_lot_balances ilb
         ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
       INNER JOIN locations l
         ON l.id = ilb.location_id AND l.tenant_id = ilb.tenant_id
       WHERE il.tenant_id = ? AND l.warehouse_id = ? AND ilb.quantity > 0
         AND p.lot_expiration_policy <> 'NONE' AND il.expires_on IS NOT NULL
         AND il.expires_on <= DATE_ADD(?, INTERVAL p.lot_expiration_alert_days DAY)
       ORDER BY il.expires_on, p.name, il.code, l.name`,
      [tenantId, warehouseId, businessDate],
    );
    return {
      businessDate,
      items: rows.map((row) => {
        const expiresOn = this.dateOnly(row.expires_on)!;
        const daysUntilExpiration = this.daysBetween(businessDate, expiresOn);
        return {
          id: `${row.lot_id}:${row.location_id}`,
          status: daysUntilExpiration < 0 ? 'EXPIRED' : 'EXPIRING',
          product: {
            id: row.product_id,
            name: row.product_name,
            sku: row.product_sku,
          },
          lot: { id: row.lot_id, code: row.lot_code, expiresOn },
          location: {
            id: row.location_id,
            name: row.location_name,
            code: row.location_code,
          },
          quantity: this.normalizeDecimal(row.quantity),
          daysUntilExpiration,
        };
      }),
    };
  }

  async listFifoLayers(
    tenantId: string,
    warehouseId: string,
    productId: string,
  ): Promise<{
    items: InventoryFifoLayerData[];
    totalQuantity: string;
    layerQuantity: string;
    currency: string | null;
    inventoryValue: string;
    cutover: {
      effectiveAt: string;
      migrationRule: 'OPENING_BALANCE_AT_MOVING_AVERAGE';
    };
  }> {
    const [product] = await this.dataSource.query<
      Array<{
        id: string;
        name: string;
        sku: string;
        total_quantity: string;
      }>
    >(
      `SELECT p.id, p.name, p.sku,
              COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.quantity ELSE 0 END), 0) AS total_quantity
       FROM products p
       LEFT JOIN inventory_balances ib
         ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
       LEFT JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       WHERE p.id = ? AND p.tenant_id = ?
       GROUP BY p.id, p.name, p.sku`,
      [warehouseId, productId, tenantId],
    );
    if (!product) throw new InventoryTargetNotFoundError();
    await this.dataSource.query(
      `INSERT INTO inventory_fifo_cutovers
         (tenant_id, effective_at, migration_rule)
       SELECT id, CURRENT_TIMESTAMP(6), 'OPENING_BALANCE_AT_MOVING_AVERAGE'
       FROM tenants WHERE id = ?
       ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id)`,
      [tenantId],
    );
    const [cutover] = await this.dataSource.query<
      Array<{ effective_at: Date | string; migration_rule: string }>
    >(
      `SELECT effective_at, migration_rule FROM inventory_fifo_cutovers
       WHERE tenant_id = ?`,
      [tenantId],
    );
    if (!cutover) throw new InventoryTargetNotFoundError();
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        origin_type: InventoryFifoLayerData['originType'];
        original_quantity: string;
        remaining_quantity: string;
        unit_cost: string;
        currency: string;
        acquired_at: Date | string;
        location_id: string;
        location_name: string;
        location_code: string;
        source_movement_id: string | null;
        source_movement_type: InventoryMovementType | null;
        source_reference: string | null;
        source_layer_id: string | null;
        purchase_receipt_line_id: string | null;
      }>
    >(
      `SELECT layer.id, layer.origin_type, layer.original_quantity,
              layer.remaining_quantity, layer.unit_cost, layer.currency,
              layer.acquired_at, l.id AS location_id, l.name AS location_name,
              l.code AS location_code, layer.source_movement_id,
              im.type AS source_movement_type, im.reference AS source_reference,
              layer.source_layer_id, layer.purchase_receipt_line_id
       FROM inventory_fifo_layers layer
       INNER JOIN locations l
         ON l.id = layer.location_id AND l.tenant_id = layer.tenant_id
       LEFT JOIN inventory_movements im
         ON im.id = layer.source_movement_id AND im.tenant_id = layer.tenant_id
       WHERE layer.tenant_id = ? AND layer.product_id = ?
         AND l.warehouse_id = ?
       ORDER BY layer.acquired_at, layer.created_at, layer.id`,
      [tenantId, productId, warehouseId],
    );
    const items = rows.map((row) => ({
      id: row.id,
      product: { id: product.id, name: product.name, sku: product.sku },
      location: {
        id: row.location_id,
        name: row.location_name,
        code: row.location_code,
      },
      originType: row.origin_type,
      originalQuantity: this.normalizeDecimal(row.original_quantity),
      remainingQuantity: this.normalizeDecimal(row.remaining_quantity),
      unitCost: this.normalizeCost(row.unit_cost),
      currency: row.currency,
      inventoryValue: this.valuationValue(
        row.remaining_quantity,
        row.unit_cost,
      ),
      acquiredAt: new Date(row.acquired_at).toISOString(),
      source: {
        movementId: row.source_movement_id,
        movementType: row.source_movement_type,
        reference: row.source_reference,
        layerId: row.source_layer_id,
        purchaseReceiptLineId: row.purchase_receipt_line_id,
      },
    }));
    const layerQuantity = this.fromUnits(
      items.reduce(
        (total, item) => total + this.toUnits(item.remainingQuantity),
        0n,
      ),
    );
    const inventoryValue = this.fromCostUnits(
      items.reduce(
        (total, item) => total + this.toCostUnits(item.inventoryValue),
        0n,
      ),
    );
    const activeCurrencies = new Set(
      items
        .filter((item) => this.toUnits(item.remainingQuantity) > 0n)
        .map((item) => item.currency),
    );
    return {
      items,
      totalQuantity: this.normalizeDecimal(product.total_quantity),
      layerQuantity,
      currency:
        activeCurrencies.size === 1 ? [...activeCurrencies.values()][0] : null,
      inventoryValue,
      cutover: {
        effectiveAt: new Date(cutover.effective_at).toISOString(),
        migrationRule:
          cutover.migration_rule as 'OPENING_BALANCE_AT_MOVING_AVERAGE',
      },
    };
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
        OR im.purchase_receipt_id LIKE ?
        OR im.purchase_return_id LIKE ? OR im.reservation_id LIKE ?
      )`);
      parameters.push(
        search,
        search,
        search,
        search,
        search,
        search,
        search,
        search,
        search,
      );
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
          sale_return_id: string | null;
          transfer_id: string | null;
          receipt_id: string | null;
          inventory_import_id: string | null;
          purchase_receipt_id: string | null;
          purchase_return_id: string | null;
          reservation_id: string | null;
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
          unit_cost: string | null;
          value_change: string | null;
          resulting_inventory_value: string | null;
          average_unit_cost: string | null;
          valuation_method: import('./inventory-valuation-policy.types').InventoryValuationMethod;
          valuation_policy_version: number | string;
          valuation_effective_at: Date | string;
          fifo_unit_cost: string | null;
          fifo_value_change: string | null;
          fifo_resulting_inventory_value: string | null;
        }>
      >(
        `SELECT im.id, im.type, im.quantity_change, im.resulting_quantity,
                im.idempotency_key, im.sale_id, im.sale_return_id,
                im.transfer_id, im.receipt_id,
                im.inventory_import_id, im.purchase_receipt_id, im.purchase_return_id,
                im.reservation_id,
                im.from_state, im.to_state, im.state_quantity,
                im.unit_cost, im.value_change, im.resulting_inventory_value,
                im.average_unit_cost, im.valuation_method,
                im.valuation_policy_version, im.valuation_effective_at,
                im.fifo_unit_cost, im.fifo_value_change,
                im.fifo_resulting_inventory_value,
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
    const allocations = rows.length
      ? await this.dataSource.query<
          Array<{
            movement_id: string;
            lot_id: string;
            code: string;
            quantity_change: string;
            unit_cost: string;
            currency: string;
            value_change: string;
            selection_mode: InventoryLotAllocation['selectionMode'];
          }>
        >(
          `SELECT iml.movement_id, il.id AS lot_id, il.code,
                  iml.quantity_change, iml.unit_cost, iml.currency,
                  iml.value_change, iml.selection_mode
           FROM inventory_movement_lots iml
           INNER JOIN inventory_lots il
             ON il.id = iml.lot_id AND il.tenant_id = iml.tenant_id
           WHERE iml.tenant_id = ? AND iml.movement_id IN (${rows.map(() => '?').join(', ')})
           ORDER BY iml.created_at, iml.id`,
          [tenantId, ...rows.map((row) => row.id)],
        )
      : [];
    const allocationsByMovement = new Map<string, InventoryLotAllocation[]>();
    for (const allocation of allocations) {
      const values = allocationsByMovement.get(allocation.movement_id) ?? [];
      values.push({
        id: allocation.lot_id,
        code: allocation.code,
        quantityChange: this.normalizeDecimal(allocation.quantity_change),
        unitCost: this.normalizeCost(allocation.unit_cost),
        currency: allocation.currency,
        valueChange: this.normalizeCost(allocation.value_change),
        selectionMode: allocation.selection_mode,
      });
      allocationsByMovement.set(allocation.movement_id, values);
    }
    const fifoAllocations = rows.length
      ? await this.dataSource.query<
          Array<{
            id: string;
            movement_id: string;
            layer_id: string;
            source_allocation_id: string | null;
            quantity_change: string;
            unit_cost: string;
            currency: string;
            value_change: string;
            selection_mode: InventoryFifoAllocation['selectionMode'];
          }>
        >(
          `SELECT id, movement_id, layer_id, source_allocation_id,
                  quantity_change, unit_cost, currency, value_change,
                  selection_mode
           FROM inventory_movement_fifo_layers
           WHERE tenant_id = ? AND movement_id IN (${rows.map(() => '?').join(', ')})
           ORDER BY created_at, id`,
          [tenantId, ...rows.map((row) => row.id)],
        )
      : [];
    const fifoAllocationsByMovement = new Map<
      string,
      InventoryFifoAllocation[]
    >();
    for (const allocation of fifoAllocations) {
      const values =
        fifoAllocationsByMovement.get(allocation.movement_id) ?? [];
      values.push({
        allocationId: allocation.id,
        layerId: allocation.layer_id,
        sourceAllocationId: allocation.source_allocation_id,
        quantityChange: this.normalizeDecimal(allocation.quantity_change),
        unitCost: this.normalizeCost(allocation.unit_cost),
        currency: allocation.currency,
        valueChange: this.normalizeCost(allocation.value_change),
        selectionMode: allocation.selection_mode,
      });
      fifoAllocationsByMovement.set(allocation.movement_id, values);
    }
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
        correlationId:
          row.sale_return_id ??
          row.sale_id ??
          row.transfer_id ??
          row.inventory_import_id ??
          row.purchase_receipt_id ??
          row.purchase_return_id ??
          row.reservation_id ??
          row.id,
        idempotencyKey: row.idempotency_key,
        document: row.sale_return_id
          ? {
              type: 'SALE_RETURN',
              id: row.sale_return_id,
              reference: row.reference,
            }
          : row.reservation_id
            ? {
                type: 'RESERVATION',
                id: row.reservation_id,
                reference: row.reference,
              }
            : row.purchase_return_id
              ? {
                  type: 'SUPPLIER_RETURN',
                  id: row.purchase_return_id,
                  reference: row.reference,
                }
              : row.purchase_receipt_id
                ? {
                    type: 'PURCHASE_RECEIPT',
                    id: row.purchase_receipt_id,
                    reference: row.reference,
                  }
                : row.inventory_import_id
                  ? {
                      type: 'IMPORT',
                      id: row.inventory_import_id,
                      reference: row.reference,
                    }
                  : row.receipt_id
                    ? {
                        type: 'RECEIPT',
                        id: row.receipt_id,
                        reference: row.reference,
                      }
                    : row.transfer_id
                      ? {
                          type: 'TRANSFER',
                          id: row.transfer_id,
                          reference: row.reference,
                        }
                      : row.sale_id
                        ? {
                            type: 'SALE',
                            id: row.sale_id,
                            reference: row.reference,
                          }
                        : {
                            type: 'MOVEMENT',
                            id: row.id,
                            reference: row.reference,
                          },
        stateTransition:
          row.from_state && row.to_state && row.state_quantity
            ? {
                from: row.from_state,
                to: row.to_state,
                quantity: this.normalizeDecimal(row.state_quantity),
              }
            : null,
        valuation:
          row.unit_cost !== null && row.value_change !== null
            ? {
                method: row.valuation_method,
                policyVersion: Number(row.valuation_policy_version),
                effectiveAt: new Date(row.valuation_effective_at).toISOString(),
                unitCost: this.normalizeCost(row.unit_cost),
                valueChange: this.normalizeCost(row.value_change),
                resultingInventoryValue:
                  row.resulting_inventory_value === null
                    ? null
                    : this.normalizeCost(row.resulting_inventory_value),
                averageUnitCost:
                  row.average_unit_cost === null
                    ? null
                    : this.normalizeCost(row.average_unit_cost),
              }
            : null,
        lots: allocationsByMovement.get(row.id) ?? [],
        fifoValuation:
          row.fifo_unit_cost !== null &&
          row.fifo_value_change !== null &&
          row.fifo_resulting_inventory_value !== null
            ? {
                unitCost: this.normalizeCost(row.fifo_unit_cost),
                valueChange: this.normalizeCost(row.fifo_value_change),
                resultingInventoryValue: this.normalizeCost(
                  row.fifo_resulting_inventory_value,
                ),
              }
            : null,
        fifoLayers: fifoAllocationsByMovement.get(row.id) ?? [],
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
    valuation: {
      method: InventoryValuationMethod;
      policyVersion: number;
      effectiveAt: string;
      currency: string;
      asOf: string;
    };
  }> {
    const scopeRows = await this.dataSource.query<
      Array<{
        branch_id: string;
        branch_name: string;
        warehouse_id: string;
        warehouse_name: string;
        country_code: string;
        timezone: string;
        valuation_method: InventoryValuationMethod;
        valuation_version: number | string;
        valuation_effective_at: Date | string;
      }>
    >(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.timezone,
              w.id AS warehouse_id, w.name AS warehouse_name,
              t.country_code, ivp.method AS valuation_method,
              ivp.version AS valuation_version,
              ivp.effective_at AS valuation_effective_at
       FROM branches b
       INNER JOIN warehouses w ON w.branch_id = b.id AND w.tenant_id = b.tenant_id
       INNER JOIN tenants t ON t.id = b.tenant_id
       INNER JOIN inventory_valuation_policies ivp ON ivp.tenant_id = b.tenant_id
       WHERE b.id = ? AND w.id = ? AND b.tenant_id = ?
         AND b.active = TRUE AND w.active = TRUE LIMIT 1`,
      [branchId, warehouseId, tenantId],
    );
    const scope = scopeRows[0];
    if (!scope) throw new InventoryTargetNotFoundError();

    const filters = ['p.tenant_id = ?', 'p.variant_schema IS NULL'];
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
          track_lots: number | boolean;
          base_unit: ProductBaseUnit;
          quantity_precision: number;
          minimum_quantity: string;
          available_quantity: string;
          reserved_quantity: string;
          damaged_quantity: string;
          in_transit_quantity: string;
          total_quantity: string;
          global_balance_quantity: string;
          valuation_quantity: string;
          average_unit_cost: string;
          total_inventory_value: string;
          lot_quantity: string;
          lot_inventory_value: string;
          lot_currency: string | null;
          fifo_quantity: string;
          fifo_inventory_value: string;
          fifo_currency: string | null;
        }>
      >(
        `SELECT p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
                p.active, p.track_lots, p.base_unit, p.quantity_precision, p.minimum_quantity,
                CASE WHEN p.track_lots THEN LEAST(
                  COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.available_quantity ELSE 0 END), 0),
                  (SELECT COALESCE(SUM(ilb.quantity), 0)
                   FROM inventory_lots il
                   INNER JOIN inventory_lot_balances ilb
                     ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
                   INNER JOIN locations usable_location
                     ON usable_location.id = ilb.location_id
                    AND usable_location.tenant_id = ilb.tenant_id
                   WHERE il.tenant_id = p.tenant_id AND il.product_id = p.id
                     AND usable_location.warehouse_id = ?
                     AND (il.expires_on IS NULL OR il.expires_on >= ?))
                ) ELSE
                  COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.available_quantity ELSE 0 END), 0)
                END AS available_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.reserved_quantity ELSE 0 END), 0) AS reserved_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.damaged_quantity ELSE 0 END), 0) AS damaged_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.in_transit_quantity ELSE 0 END), 0) AS in_transit_quantity,
                COALESCE(SUM(CASE WHEN l.warehouse_id = ? THEN ib.quantity ELSE 0 END), 0) AS total_quantity,
                COALESCE(SUM(ib.quantity), 0) AS global_balance_quantity,
                COALESCE(iv.quantity, 0) AS valuation_quantity,
                COALESCE(iv.average_unit_cost, p.cost) AS average_unit_cost,
                COALESCE(iv.inventory_value, 0) AS total_inventory_value
                ,(SELECT COALESCE(SUM(ilb.quantity), 0)
                  FROM inventory_lots il
                  INNER JOIN inventory_lot_balances ilb
                    ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
                  INNER JOIN locations ll
                    ON ll.id = ilb.location_id AND ll.tenant_id = ilb.tenant_id
                  WHERE il.tenant_id = p.tenant_id AND il.product_id = p.id
                    AND ll.warehouse_id = ?) AS lot_quantity,
                (SELECT COALESCE(SUM(ilb.quantity * il.unit_cost), 0)
                  FROM inventory_lots il
                  INNER JOIN inventory_lot_balances ilb
                    ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
                  INNER JOIN locations ll
                    ON ll.id = ilb.location_id AND ll.tenant_id = ilb.tenant_id
                  WHERE il.tenant_id = p.tenant_id AND il.product_id = p.id
                    AND ll.warehouse_id = ?) AS lot_inventory_value,
                (SELECT CASE WHEN COUNT(DISTINCT il.currency) = 1
                             THEN MIN(il.currency) ELSE NULL END
                  FROM inventory_lots il
                  INNER JOIN inventory_lot_balances ilb
                    ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
                  INNER JOIN locations ll
                    ON ll.id = ilb.location_id AND ll.tenant_id = ilb.tenant_id
                  WHERE il.tenant_id = p.tenant_id AND il.product_id = p.id
                    AND ll.warehouse_id = ? AND ilb.quantity > 0) AS lot_currency,
                (SELECT COALESCE(SUM(layer.remaining_quantity), 0)
                  FROM inventory_fifo_layers layer
                  INNER JOIN locations fl
                    ON fl.id = layer.location_id AND fl.tenant_id = layer.tenant_id
                  WHERE layer.tenant_id = p.tenant_id AND layer.product_id = p.id
                    AND fl.warehouse_id = ?) AS fifo_quantity,
                (SELECT CAST(COALESCE(SUM(layer.remaining_quantity * layer.unit_cost), 0)
                  AS DECIMAL(21,4))
                  FROM inventory_fifo_layers layer
                  INNER JOIN locations fl
                    ON fl.id = layer.location_id AND fl.tenant_id = layer.tenant_id
                  WHERE layer.tenant_id = p.tenant_id AND layer.product_id = p.id
                    AND fl.warehouse_id = ?) AS fifo_inventory_value,
                (SELECT CASE WHEN COUNT(DISTINCT layer.currency) = 1
                             THEN MIN(layer.currency) ELSE NULL END
                  FROM inventory_fifo_layers layer
                  INNER JOIN locations fl
                    ON fl.id = layer.location_id AND fl.tenant_id = layer.tenant_id
                  WHERE layer.tenant_id = p.tenant_id AND layer.product_id = p.id
                    AND fl.warehouse_id = ?
                    AND layer.remaining_quantity > 0) AS fifo_currency
         FROM products p
         LEFT JOIN inventory_balances ib ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
         LEFT JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         LEFT JOIN inventory_valuations iv ON iv.product_id = p.id AND iv.tenant_id = p.tenant_id
         WHERE ${where}
         GROUP BY p.id, p.name, p.sku, p.active, p.track_lots, p.base_unit,
                  p.quantity_precision, p.minimum_quantity, p.cost, p.created_at,
                  iv.quantity, iv.average_unit_cost, iv.inventory_value
         ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
        [
          warehouseId,
          warehouseId,
          this.localDate(scope.timezone),
          warehouseId,
          warehouseId,
          warehouseId,
          warehouseId,
          warehouseId,
          warehouseId,
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
    const tenantCurrency = this.currencyForCountry(scope.country_code);
    return {
      items: rows.map((row) => {
        const available = this.normalizeDecimal(row.available_quantity);
        const reserved = this.normalizeDecimal(row.reserved_quantity);
        const damaged = this.normalizeDecimal(row.damaged_quantity);
        const inTransit = this.normalizeDecimal(row.in_transit_quantity);
        const total = this.normalizeDecimal(row.total_quantity);
        const quantityReconciled =
          this.toUnits(row.global_balance_quantity) ===
          this.toUnits(row.valuation_quantity);
        const valueReconciled = this.isValuationValueReconciled(
          row.valuation_quantity,
          row.average_unit_cost,
          row.total_inventory_value,
        );
        const movingAverageValue = this.valuationValue(
          row.total_quantity,
          row.average_unit_cost,
        );
        const movingAverageReconciled = quantityReconciled && valueReconciled;
        const lotReconciled =
          this.toUnits(row.lot_quantity) === this.toUnits(row.total_quantity);
        const fifoReconciled =
          this.toUnits(row.fifo_quantity) === this.toUnits(row.total_quantity);
        const costing =
          scope.valuation_method === 'FIFO'
            ? {
                method: scope.valuation_method,
                currency: row.fifo_currency ?? tenantCurrency,
                quantity: this.normalizeDecimal(row.fifo_quantity),
                inventoryValue: this.normalizeCost(row.fifo_inventory_value),
                reconciled: fifoReconciled,
              }
            : scope.valuation_method === 'SPECIFIC_LOT'
              ? {
                  method: scope.valuation_method,
                  currency: row.lot_currency ?? tenantCurrency,
                  quantity: this.normalizeDecimal(row.lot_quantity),
                  inventoryValue: this.normalizeCost(row.lot_inventory_value),
                  reconciled: lotReconciled,
                }
              : {
                  method: scope.valuation_method,
                  currency: tenantCurrency,
                  quantity: total,
                  inventoryValue: movingAverageValue,
                  reconciled: movingAverageReconciled,
                };
        return {
          product: {
            id: row.product_id,
            name: row.product_name,
            sku: row.product_sku,
            active: Boolean(row.active),
            trackLots: Boolean(row.track_lots),
            baseUnit: row.base_unit,
            quantityPrecision: Number(row.quantity_precision),
            minimumQuantity: row.minimum_quantity,
          },
          availableQuantity: available,
          totalQuantity: total,
          states: [
            { code: 'AVAILABLE', quantity: available },
            { code: 'RESERVED', quantity: reserved },
            { code: 'DAMAGED', quantity: damaged },
            { code: 'IN_TRANSIT', quantity: inTransit },
          ],
          averageUnitCost: this.normalizeCost(row.average_unit_cost),
          inventoryValue: costing.inventoryValue,
          costing,
          valuation: {
            quantity: this.normalizeDecimal(row.valuation_quantity),
            inventoryValue: this.normalizeCost(row.total_inventory_value),
            quantityReconciled,
            valueReconciled,
            reconciled: movingAverageReconciled,
          },
          lotTracking: row.track_lots
            ? {
                lotQuantity: this.normalizeDecimal(row.lot_quantity),
                reconciled: lotReconciled,
                currency: row.lot_currency,
                inventoryValue: this.normalizeCost(row.lot_inventory_value),
              }
            : null,
          fifoValuation: {
            quantity: this.normalizeDecimal(row.fifo_quantity),
            inventoryValue: this.normalizeCost(row.fifo_inventory_value),
            currency: row.fifo_currency,
            reconciled: fifoReconciled,
          },
        };
      }),
      total: Number(countRows[0]?.total ?? 0),
      scope: {
        branch: { id: scope.branch_id, name: scope.branch_name },
        warehouse: { id: scope.warehouse_id, name: scope.warehouse_name },
      },
      valuation: {
        method: scope.valuation_method,
        policyVersion: Number(scope.valuation_version),
        effectiveAt: new Date(scope.valuation_effective_at).toISOString(),
        currency: tenantCurrency,
        asOf: new Date().toISOString(),
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
       WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE
         AND p.variant_schema IS NULL LIMIT 1`,
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
    const policy = await this.productQuantityPolicy(
      input.tenantId,
      input.dto.productId,
    );
    const normalizedInput = normalizeProductQuantity(
      input.dto.quantity,
      policy,
      {
        allowNegative: input.dto.type === 'ADJUSTMENT',
      },
    );
    const quantityChange = this.quantityChange(input.dto, normalizedInput);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          productId: input.dto.productId,
          locationId: input.dto.locationId,
          type: input.dto.type,
          quantity: quantityChange,
          reason: input.dto.reason,
          reference: input.dto.reference ?? null,
          serialNumbers: input.dto.serialNumbers ?? [],
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
          const movementId = randomUUID();
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
          await applyInventoryValuation(manager, movementId);
          await applyInventoryLotTracking(manager, movementId, {
            lotCode: input.dto.lotCode,
            manufacturedOn: input.dto.manufacturedOn,
            expiresOn: input.dto.expiresOn,
          });
          await applyInventorySerialTracking(manager, movementId, {
            serialNumbers: input.dto.serialNumbers,
          });
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

  async createCount(
    input: {
      tenantId: string;
      warehouseId: string;
      userId: string;
      idempotencyKey: string;
      dto: InventoryCountInput;
    },
    attempt = 0,
  ): Promise<{ count: InventoryCountData; replay: boolean }> {
    const policy = await this.productQuantityPolicy(
      input.tenantId,
      input.dto.productId,
    );
    const snapshotUnits = this.toUnits(
      normalizeProductQuantity(input.dto.snapshotQuantity, policy, {
        enforceMinimum: false,
      }),
    );
    const countedUnits = this.toUnits(
      normalizeProductQuantity(input.dto.countedQuantity, policy, {
        enforceMinimum: false,
      }),
    );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          productId: input.dto.productId,
          locationId: input.dto.locationId,
          snapshotQuantity: this.fromUnits(snapshotUnits),
          countedQuantity: this.fromUnits(countedUnits),
          reason: input.dto.reason,
          reference: input.dto.reference,
          capturedAt: input.dto.capturedAt,
        }),
      )
      .digest('hex');

    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findCount(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) {
            if (existing.request_fingerprint !== fingerprint)
              throw new IdempotencyConflictError();
            return { count: this.toCount(existing), replay: true };
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
          const replay = await this.findCount(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.request_fingerprint !== fingerprint)
              throw new IdempotencyConflictError();
            return { count: this.toCount(replay), replay: true };
          }
          const currentUnits = this.toUnits(balance.available_quantity);
          if (currentUnits !== snapshotUnits) {
            throw new InventoryCountConflictError(this.fromUnits(currentUnits));
          }
          const varianceUnits = countedUnits - currentUnits;
          const resultingTotalUnits =
            this.toUnits(balance.quantity) + varianceUnits;
          if (resultingTotalUnits < 0n) throw new InsufficientStockError();

          let movementId: string | null = null;
          if (varianceUnits !== 0n) {
            movementId = randomUUID();
            const variance = this.fromUnits(varianceUnits);
            const resultingTotal = this.fromUnits(resultingTotalUnits);
            await manager.query(
              `UPDATE inventory_balances
               SET quantity = ?, available_quantity = ?
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                resultingTotal,
                this.fromUnits(countedUnits),
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
               VALUES (?, ?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
              [
                movementId,
                input.tenantId,
                input.dto.productId,
                input.dto.locationId,
                variance,
                resultingTotal,
                input.dto.reason,
                input.dto.reference,
                input.idempotencyKey,
                fingerprint,
                input.userId,
              ],
            );
            await applyInventoryValuation(manager, movementId);
            await applyInventoryLotTracking(manager, movementId);
            await applyInventorySerialTracking(manager, movementId);
          }
          await manager.query(
            `INSERT INTO inventory_counts
              (id, tenant_id, product_id, location_id, snapshot_quantity,
               counted_quantity, variance_quantity, reason, reference,
               device_captured_at, created_by_user_id, movement_id,
               idempotency_key, request_fingerprint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              input.tenantId,
              input.dto.productId,
              input.dto.locationId,
              this.fromUnits(snapshotUnits),
              this.fromUnits(countedUnits),
              this.fromUnits(varianceUnits),
              input.dto.reason,
              input.dto.reference,
              new Date(input.dto.capturedAt),
              input.userId,
              movementId,
              input.idempotencyKey,
              fingerprint,
            ],
          );
          const count = await this.findCount(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (!count) throw new Error('CREATED_INVENTORY_COUNT_NOT_FOUND');
          return { count: this.toCount(count), replay: false };
        },
      );
    } catch (error) {
      if (this.isTransactionConflict(error) && attempt < 2) {
        return this.createCount(input, attempt + 1);
      }
      if (!this.isDuplicate(error)) throw error;
      const count = await this.findCount(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!count || count.request_fingerprint !== fingerprint)
        throw new IdempotencyConflictError();
      return { count: this.toCount(count), replay: true };
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
    const policy = await this.productQuantityPolicy(
      input.tenantId,
      input.dto.productId,
    );
    const quantityUnits = this.toUnits(
      normalizeProductQuantity(input.dto.quantity, policy),
    );
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
          serialNumbers: input.dto.serialNumbers ?? [],
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
          const movementId = randomUUID();
          await manager.query(
            `INSERT INTO inventory_movements
              (id, tenant_id, product_id, location_id, type, from_state, to_state,
               state_quantity, quantity_change, resulting_quantity, reason, reference,
               idempotency_key, request_fingerprint, created_by_user_id)
             VALUES (?, ?, ?, ?, 'STATE_TRANSITION', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            [
              movementId,
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
          await applyInventoryValuation(manager, movementId);
          await applyInventoryLotTracking(manager, movementId);
          await applyInventorySerialTracking(manager, movementId, {
            serialNumbers: input.dto.serialNumbers,
          });
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
       WHERE p.id = ? AND p.tenant_id = ? AND p.active = TRUE
         AND p.variant_schema IS NULL LIMIT 1`,
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
              im.unit_cost, im.value_change, im.resulting_inventory_value,
              im.average_unit_cost, im.valuation_method,
              im.valuation_policy_version, im.valuation_effective_at,
              im.fifo_unit_cost, im.fifo_value_change,
              im.fifo_resulting_inventory_value,
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

  private async findCount(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CountRow | null> {
    const rows = await manager.query<CountRow[]>(
      `SELECT ic.id, ic.snapshot_quantity, ic.counted_quantity,
              ic.variance_quantity, ic.reason, ic.reference,
              ic.device_captured_at, ic.created_at, ic.movement_id,
              ic.request_fingerprint,
              p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code
       FROM inventory_counts ic
       INNER JOIN products p ON p.id = ic.product_id AND p.tenant_id = ic.tenant_id
       INNER JOIN locations l ON l.id = ic.location_id AND l.tenant_id = ic.tenant_id
       WHERE ic.tenant_id = ? AND ic.idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  private quantityChange(
    dto: CreateInventoryMovementDto,
    normalizedQuantity: string,
  ): string {
    const units = this.toUnits(normalizedQuantity);
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

  private async productQuantityPolicy(
    tenantId: string,
    productId: string,
  ): Promise<ProductQuantityPolicy> {
    const [row] = await this.dataSource.query<
      Array<{
        base_unit: ProductBaseUnit;
        quantity_precision: number;
        quantity_rounding: QuantityRoundingMode;
        minimum_quantity: string;
      }>
    >(
      `SELECT base_unit, quantity_precision, quantity_rounding, minimum_quantity
       FROM products WHERE id = ? AND tenant_id = ? AND active = TRUE LIMIT 1`,
      [productId, tenantId],
    );
    if (!row) throw new InventoryTargetNotFoundError();
    return {
      baseUnit: row.base_unit,
      precision: Number(row.quantity_precision),
      rounding: row.quantity_rounding,
      minimumQuantity: row.minimum_quantity,
    };
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

  private normalizeCost(value: string): string {
    return this.fromCostUnits(this.toCostUnits(value));
  }

  private valuationValue(quantity: string, unitCost: string): string {
    const numerator = this.toUnits(quantity) * this.toCostUnits(unitCost);
    const rounded =
      numerator >= 0n ? (numerator + 500n) / 1000n : (numerator - 500n) / 1000n;
    return this.fromCostUnits(rounded);
  }

  private currencyForCountry(countryCode: string): string {
    return { MX: 'MXN', CL: 'CLP' }[countryCode] ?? 'USD';
  }

  private isValuationValueReconciled(
    quantity: string,
    averageUnitCost: string,
    inventoryValue: string,
  ): boolean {
    const quantityUnits = this.toUnits(quantity);
    const expectedValue = this.toCostUnits(
      this.valuationValue(quantity, averageUnitCost),
    );
    const actualValue = this.toCostUnits(inventoryValue);
    const difference =
      expectedValue >= actualValue
        ? expectedValue - actualValue
        : actualValue - expectedValue;
    const absoluteQuantity =
      quantityUnits < 0n ? -quantityUnits : quantityUnits;
    const roundingTolerance = (absoluteQuantity + 1999n) / 2000n;
    return difference <= roundingTolerance;
  }

  private toCostUnits(value: string): bigint {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const units =
      BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
    return negative ? -units : units;
  }

  private fromCostUnits(units: bigint): string {
    const sign = units < 0n ? '-' : '';
    const absolute = units < 0n ? -units : units;
    return `${sign}${absolute / 10000n}.${String(absolute % 10000n).padStart(4, '0')}`;
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
      valuation:
        row.unit_cost !== null && row.value_change !== null
          ? {
              method: row.valuation_method,
              policyVersion: Number(row.valuation_policy_version),
              effectiveAt: new Date(row.valuation_effective_at).toISOString(),
              unitCost: this.normalizeCost(row.unit_cost),
              valueChange: this.normalizeCost(row.value_change),
              resultingInventoryValue:
                row.resulting_inventory_value === null
                  ? null
                  : this.normalizeCost(row.resulting_inventory_value),
              averageUnitCost:
                row.average_unit_cost === null
                  ? null
                  : this.normalizeCost(row.average_unit_cost),
            }
          : null,
      fifoValuation:
        row.fifo_unit_cost !== null &&
        row.fifo_value_change !== null &&
        row.fifo_resulting_inventory_value !== null
          ? {
              unitCost: this.normalizeCost(row.fifo_unit_cost),
              valueChange: this.normalizeCost(row.fifo_value_change),
              resultingInventoryValue: this.normalizeCost(
                row.fifo_resulting_inventory_value,
              ),
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

  private toCount(row: CountRow): InventoryCountData {
    return {
      id: row.id,
      snapshotQuantity: this.normalizeDecimal(row.snapshot_quantity),
      countedQuantity: this.normalizeDecimal(row.counted_quantity),
      varianceQuantity: this.normalizeDecimal(row.variance_quantity),
      reason: row.reason,
      reference: row.reference,
      capturedAt: new Date(row.device_captured_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      movementId: row.movement_id,
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

  private localDate(timezone: string, now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  private dateOnly(value: string | Date | null): string | null {
    if (!value) return null;
    return value instanceof Date
      ? value.toISOString().slice(0, 10)
      : value.slice(0, 10);
  }

  private daysBetween(from: string, to: string): number {
    const fromTime = Date.parse(`${from}T00:00:00.000Z`);
    const toTime = Date.parse(`${to}T00:00:00.000Z`);
    return Math.round((toTime - fromTime) / 86_400_000);
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }

  private isTransactionConflict(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      [1205, 1213].includes(
        (error.driverError as { errno?: number }).errno ?? 0,
      )
    );
  }
}

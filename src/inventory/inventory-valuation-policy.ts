import { EntityManager } from 'typeorm';
import {
  InventoryFifoLayerShortageError,
  InventoryLotRequiredError,
} from './inventory.errors';
import type {
  InventoryValuationMethod,
  InventoryValuationPolicyData,
} from './inventory-valuation-policy.types';

interface PolicyRow {
  method: InventoryValuationMethod;
  version: number | string;
  effective_at: Date | string;
  migration_rule: 'INITIAL_DEFAULT' | 'FORWARD_ONLY_CUTOVER';
}

interface MovementPolicyRow {
  tenant_id: string;
  product_id: string;
  quantity_change: string;
  fifo_unit_cost: string | null;
  fifo_value_change: string | null;
  fifo_resulting_inventory_value: string | null;
}

const QUANTITY_SCALE = 1000n;
const COST_SCALE = 10000n;

function scaled(value: string, scale: bigint, decimals: number): bigint {
  const normalized = String(value).trim();
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const result =
    BigInt(whole || '0') * scale +
    BigInt(fraction.padEnd(decimals, '0').slice(0, decimals) || '0');
  return negative ? -result : result;
}

function decimal(value: bigint, scale: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / scale}.${String(
    absolute % scale,
  ).padStart(decimals, '0')}`;
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('INVALID_VALUATION_DIVISOR');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function iso(value: Date | string): string {
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

export async function loadInventoryValuationPolicy(
  manager: EntityManager,
  tenantId: string,
  lock = false,
): Promise<InventoryValuationPolicyData> {
  await manager.query(
    `INSERT INTO inventory_valuation_policies
       (tenant_id, method, version, effective_at, migration_rule)
     VALUES (?, 'MOVING_AVERAGE', 1, CURRENT_TIMESTAMP(6), 'INITIAL_DEFAULT')
     ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id)`,
    [tenantId],
  );
  const [row] = await manager.query<PolicyRow[]>(
    `SELECT method, version, effective_at, migration_rule
     FROM inventory_valuation_policies WHERE tenant_id = ?${
       lock ? ' FOR UPDATE' : ''
     }`,
    [tenantId],
  );
  if (!row) throw new Error('INVENTORY_VALUATION_POLICY_NOT_FOUND');
  return {
    method: row.method,
    version: Number(row.version),
    effectiveAt: iso(row.effective_at),
    migrationRule: row.migration_rule,
  };
}

export async function sealInventoryMovementValuation(
  manager: EntityManager,
  movementId: string,
): Promise<InventoryValuationMethod> {
  const [movement] = await manager.query<MovementPolicyRow[]>(
    `SELECT tenant_id, product_id, quantity_change, fifo_unit_cost,
            fifo_value_change, fifo_resulting_inventory_value
     FROM inventory_movements WHERE id = ?`,
    [movementId],
  );
  if (!movement) throw new Error('INVENTORY_MOVEMENT_NOT_FOUND_FOR_POLICY');
  const policy = await loadInventoryValuationPolicy(
    manager,
    movement.tenant_id,
    true,
  );
  if (
    policy.method === 'FIFO' &&
    (movement.fifo_unit_cost === null ||
      movement.fifo_value_change === null ||
      movement.fifo_resulting_inventory_value === null)
  ) {
    throw new InventoryFifoLayerShortageError();
  }
  await manager.query(
    `UPDATE inventory_movements
     SET valuation_method = ?, valuation_policy_version = ?,
         valuation_effective_at = ?,
         unit_cost = CASE WHEN ? = 'FIFO' THEN fifo_unit_cost ELSE unit_cost END,
         value_change = CASE WHEN ? = 'FIFO' THEN fifo_value_change ELSE value_change END,
         resulting_inventory_value = CASE
           WHEN ? = 'FIFO' THEN fifo_resulting_inventory_value
           ELSE resulting_inventory_value END
     WHERE id = ? AND tenant_id = ?`,
    [
      policy.method,
      policy.version,
      policy.effectiveAt.slice(0, 23).replace('T', ' ').replace('Z', ''),
      policy.method,
      policy.method,
      policy.method,
      movementId,
      movement.tenant_id,
    ],
  );
  return policy.method;
}

export async function finalizeSpecificLotMovementValuation(
  manager: EntityManager,
  movementId: string,
): Promise<void> {
  const [movement] = await manager.query<
    Array<{
      tenant_id: string;
      product_id: string;
      quantity_change: string;
      valuation_method: InventoryValuationMethod;
    }>
  >(
    `SELECT tenant_id, product_id, quantity_change, valuation_method
     FROM inventory_movements WHERE id = ?`,
    [movementId],
  );
  if (!movement || movement.valuation_method !== 'SPECIFIC_LOT') return;
  const [product] = await manager.query<
    Array<{ track_lots: boolean | number }>
  >(
    `SELECT track_lots FROM products
     WHERE id = ? AND tenant_id = ? FOR UPDATE`,
    [movement.product_id, movement.tenant_id],
  );
  if (!product?.track_lots) throw new InventoryLotRequiredError();
  const [allocation] = await manager.query<
    Array<{ quantity: string; value_change: string }>
  >(
    `SELECT COALESCE(SUM(quantity_change), 0) AS quantity,
              COALESCE(SUM(value_change), 0) AS value_change
       FROM inventory_movement_lots
       WHERE tenant_id = ? AND movement_id = ?`,
    [movement.tenant_id, movementId],
  );
  const [totals] = await manager.query<
    Array<{ quantity: string; inventory_value: string }>
  >(
    `SELECT COALESCE(SUM(ilb.quantity), 0) AS quantity,
              COALESCE(SUM(ilb.quantity * il.unit_cost), 0) AS inventory_value
       FROM inventory_lot_balances ilb
       INNER JOIN inventory_lots il
         ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
       WHERE ilb.tenant_id = ? AND il.product_id = ?`,
    [movement.tenant_id, movement.product_id],
  );
  const [valuation] = await manager.query<Array<{ quantity: string }>>(
    `SELECT quantity FROM inventory_valuations
       WHERE tenant_id = ? AND product_id = ?`,
    [movement.tenant_id, movement.product_id],
  );
  const movementQuantity = scaled(movement.quantity_change, QUANTITY_SCALE, 3);
  const allocatedQuantity = scaled(allocation.quantity, QUANTITY_SCALE, 3);
  if (
    !valuation ||
    allocatedQuantity !== movementQuantity ||
    scaled(totals.quantity, QUANTITY_SCALE, 3) !==
      scaled(valuation.quantity, QUANTITY_SCALE, 3)
  ) {
    throw new Error('SPECIFIC_LOT_RECONCILIATION_FAILED');
  }
  const valueChange = scaled(allocation.value_change, COST_SCALE, 4);
  const absoluteQuantity =
    movementQuantity < 0n ? -movementQuantity : movementQuantity;
  const absoluteValue = valueChange < 0n ? -valueChange : valueChange;
  const unitCost =
    absoluteQuantity === 0n
      ? 0n
      : divideRounded(absoluteValue * QUANTITY_SCALE, absoluteQuantity);
  await manager.query(
    `UPDATE inventory_movements
     SET unit_cost = ?, value_change = ?, resulting_inventory_value = ?
     WHERE id = ? AND tenant_id = ?`,
    [
      decimal(unitCost, COST_SCALE, 4),
      decimal(valueChange, COST_SCALE, 4),
      totals.inventory_value,
      movementId,
      movement.tenant_id,
    ],
  );
}

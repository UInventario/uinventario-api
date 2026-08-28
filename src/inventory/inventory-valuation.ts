import { EntityManager } from 'typeorm';
import { applyInventoryFifoValuation } from './inventory-fifo-valuation';

interface MovementValuationRow {
  tenant_id: string;
  product_id: string;
  location_id: string;
  type: string;
  quantity_change: string;
  purchase_receipt_line_id: string | null;
  sale_id: string | null;
  sale_line_id: string | null;
}

interface InventoryValuationRow {
  quantity: string;
  inventory_value: string;
  average_unit_cost: string;
}

const QUANTITY_DECIMALS = 3;
const MONEY_DECIMALS = 4;
const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_DECIMALS);

function toScaled(value: string, decimals: number): bigint {
  const normalized = String(value).trim();
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const paddedFraction = `${fraction}${'0'.repeat(decimals)}`.slice(
    0,
    decimals,
  );
  const result =
    BigInt(whole || '0') * 10n ** BigInt(decimals) +
    BigInt(paddedFraction || '0');
  return negative ? -result : result;
}

function fromScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
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

function quantityTimesCost(quantity: bigint, unitCost: bigint): bigint {
  return divideRounded(quantity * unitCost, QUANTITY_SCALE);
}

async function resolveSourceCost(
  manager: EntityManager,
  movement: MovementValuationRow,
  currentAverage: bigint,
): Promise<bigint> {
  if (movement.type === 'PURCHASE_RECEIPT') {
    const [line] = await manager.query<{ unit_cost: string }[]>(
      `SELECT unit_cost
       FROM purchase_receipt_lines
       WHERE id = ? AND tenant_id = ?`,
      [movement.purchase_receipt_line_id, movement.tenant_id],
    );
    if (!line) throw new Error('PURCHASE_RECEIPT_COST_NOT_FOUND');
    return toScaled(line.unit_cost, MONEY_DECIMALS);
  }

  if (movement.type === 'SALE_VOID') {
    const [originalMovement] = await manager.query<{ unit_cost: string }[]>(
      `SELECT unit_cost
       FROM inventory_movements
       WHERE tenant_id = ? AND sale_id = ? AND sale_line_id = ?
         AND location_id = ? AND type = 'SALE' AND unit_cost IS NOT NULL
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [
        movement.tenant_id,
        movement.sale_id,
        movement.sale_line_id,
        movement.location_id,
      ],
    );
    if (!originalMovement) throw new Error('SALE_MOVEMENT_COST_NOT_FOUND');
    return toScaled(originalMovement.unit_cost, MONEY_DECIMALS);
  }

  return currentAverage;
}

/**
 * Applies moving-average valuation after an inventory movement is inserted.
 * Quantity uses 3 decimal places; costs and values use 4. The valuation row is
 * locked so movements for the same tenant and product are serialized.
 */
export async function applyInventoryValuation(
  manager: EntityManager,
  movementId: string,
): Promise<void> {
  const [movement] = await manager.query<MovementValuationRow[]>(
    `SELECT tenant_id, product_id, location_id, type, quantity_change,
            purchase_receipt_line_id, sale_id, sale_line_id
     FROM inventory_movements
     WHERE id = ?`,
    [movementId],
  );
  if (!movement) throw new Error('INVENTORY_MOVEMENT_NOT_FOUND_FOR_VALUATION');

  await manager.query(
    `INSERT INTO inventory_valuations
       (tenant_id, product_id, quantity, inventory_value, average_unit_cost)
     SELECT tenant_id, id, 0, 0, CAST(cost AS DECIMAL(15,4))
     FROM products
     WHERE id = ? AND tenant_id = ?
     ON DUPLICATE KEY UPDATE product_id = VALUES(product_id)`,
    [movement.product_id, movement.tenant_id],
  );

  const [valuation] = await manager.query<InventoryValuationRow[]>(
    `SELECT quantity, inventory_value, average_unit_cost
     FROM inventory_valuations
     WHERE tenant_id = ? AND product_id = ?
     FOR UPDATE`,
    [movement.tenant_id, movement.product_id],
  );
  if (!valuation) throw new Error('INVENTORY_VALUATION_NOT_FOUND');

  const currentQuantity = toScaled(valuation.quantity, QUANTITY_DECIMALS);
  const currentValue = toScaled(valuation.inventory_value, MONEY_DECIMALS);
  const currentAverage = toScaled(valuation.average_unit_cost, MONEY_DECIMALS);
  const quantityChange = toScaled(movement.quantity_change, QUANTITY_DECIMALS);
  const newQuantity = currentQuantity + quantityChange;
  if (newQuantity < 0n)
    throw new Error('NEGATIVE_INVENTORY_VALUATION_QUANTITY');

  const isValuedEntry =
    quantityChange > 0n &&
    (movement.type === 'PURCHASE_RECEIPT' || movement.type === 'SALE_VOID');
  const unitCost = isValuedEntry
    ? await resolveSourceCost(manager, movement, currentAverage)
    : currentAverage;
  const newValue =
    newQuantity === 0n
      ? 0n
      : currentValue + quantityTimesCost(quantityChange, unitCost);
  if (newValue < 0n) throw new Error('NEGATIVE_INVENTORY_VALUATION_VALUE');
  const newAverage =
    isValuedEntry && newQuantity > 0n
      ? divideRounded(newValue * QUANTITY_SCALE, newQuantity)
      : currentAverage;
  const valueChange = newValue - currentValue;

  await manager.query(
    `UPDATE inventory_valuations
     SET quantity = ?, inventory_value = ?, average_unit_cost = ?,
         version = version + ?
     WHERE tenant_id = ? AND product_id = ?`,
    [
      fromScaled(newQuantity, QUANTITY_DECIMALS),
      fromScaled(newValue, MONEY_DECIMALS),
      fromScaled(newAverage, MONEY_DECIMALS),
      quantityChange === 0n ? 0 : 1,
      movement.tenant_id,
      movement.product_id,
    ],
  );
  await manager.query(
    `UPDATE inventory_movements
     SET unit_cost = ?, value_change = ?, resulting_inventory_value = ?,
         average_unit_cost = ?
     WHERE id = ? AND tenant_id = ?`,
    [
      fromScaled(unitCost, MONEY_DECIMALS),
      fromScaled(valueChange, MONEY_DECIMALS),
      fromScaled(newValue, MONEY_DECIMALS),
      fromScaled(newAverage, MONEY_DECIMALS),
      movementId,
      movement.tenant_id,
    ],
  );

  if (isValuedEntry) {
    const catalogCost = divideRounded(newAverage, 100n) * 100n;
    await manager.query(
      `UPDATE products
       SET cost = ?, version = version + 1
       WHERE id = ? AND tenant_id = ? AND cost <> ?`,
      [
        fromScaled(catalogCost, MONEY_DECIMALS),
        movement.product_id,
        movement.tenant_id,
        fromScaled(catalogCost, MONEY_DECIMALS),
      ],
    );
  }

  await applyInventoryFifoValuation(manager, movementId);
}

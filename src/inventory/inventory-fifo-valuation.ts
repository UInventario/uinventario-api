import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import {
  InventoryFifoCurrencyMismatchError,
  InventoryFifoLayerShortageError,
} from './inventory.errors';

type AllocationMode =
  'ENTRY' | 'FIFO' | 'RESTORE' | 'TRANSFER' | 'ORIGIN_RETURN';

type LayerOrigin = 'ENTRY' | 'PURCHASE_RECEIPT' | 'RETURN' | 'TRANSFER';

interface FifoMovementRow {
  id: string;
  tenant_id: string;
  product_id: string;
  location_id: string;
  type: string;
  quantity_change: string;
  purchase_receipt_line_id: string | null;
  purchase_return_line_id: string | null;
  sale_id: string | null;
  sale_line_id: string | null;
  transfer_line_id: string | null;
  unit_cost: string | null;
  country_code: string;
  created_at: Date | string;
}

interface FifoLayerRow {
  id: string;
  remaining_quantity: string;
  unit_cost: string;
  currency: string;
  acquired_at: Date | string;
}

interface SourceAllocationRow {
  id: string;
  layer_id: string;
  quantity_change: string;
  unit_cost: string;
  currency: string;
  acquired_at: Date | string;
}

const QUANTITY_SCALE = 1000n;
const COST_SCALE = 10000n;

function quantityUnits(value: string): bigint {
  const normalized = String(value).trim();
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const result =
    BigInt(whole || '0') * QUANTITY_SCALE +
    BigInt(fraction.padEnd(3, '0').slice(0, 3) || '0');
  return negative ? -result : result;
}

function quantityDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / QUANTITY_SCALE}.${String(
    absolute % QUANTITY_SCALE,
  ).padStart(3, '0')}`;
}

function costUnits(value: string): bigint {
  const normalized = String(value).trim();
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const result =
    BigInt(whole || '0') * COST_SCALE +
    BigInt(fraction.padEnd(4, '0').slice(0, 4) || '0');
  return negative ? -result : result;
}

function costDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / COST_SCALE}.${String(
    absolute % COST_SCALE,
  ).padStart(4, '0')}`;
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('INVALID_FIFO_DIVISOR');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function quantityValue(quantity: bigint, unitCost: bigint): bigint {
  return divideRounded(quantity * unitCost, QUANTITY_SCALE);
}

function tenantCurrency(countryCode: string): string {
  if (countryCode === 'MX') return 'MXN';
  if (countryCode === 'CL') return 'CLP';
  return 'USD';
}

async function ensureCutover(
  manager: EntityManager,
  movement: FifoMovementRow,
): Promise<void> {
  await manager.query(
    `INSERT INTO inventory_fifo_cutovers
       (tenant_id, effective_at, migration_rule)
     VALUES (?, ?, 'OPENING_BALANCE_AT_MOVING_AVERAGE')
     ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id)`,
    [movement.tenant_id, movement.created_at],
  );
}

async function assertCurrency(
  manager: EntityManager,
  movement: FifoMovementRow,
  currency: string,
): Promise<void> {
  const [existing] = await manager.query<Array<{ currency: string }>>(
    `SELECT currency FROM inventory_fifo_layers
     WHERE tenant_id = ? AND product_id = ?
     ORDER BY acquired_at, id LIMIT 1`,
    [movement.tenant_id, movement.product_id],
  );
  if (existing && existing.currency !== currency) {
    throw new InventoryFifoCurrencyMismatchError();
  }
}

async function insertAllocation(
  manager: EntityManager,
  movement: FifoMovementRow,
  input: {
    layerId: string;
    quantity: bigint;
    unitCost: string;
    currency: string;
    mode: AllocationMode;
    sourceAllocationId?: string;
  },
): Promise<bigint> {
  const value = quantityValue(input.quantity, costUnits(input.unitCost));
  await manager.query(
    `INSERT INTO inventory_movement_fifo_layers
       (id, tenant_id, movement_id, layer_id, source_allocation_id,
        quantity_change, unit_cost, currency, value_change, selection_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      movement.tenant_id,
      movement.id,
      input.layerId,
      input.sourceAllocationId ?? null,
      quantityDecimal(input.quantity),
      input.unitCost,
      input.currency,
      costDecimal(value),
      input.mode,
    ],
  );
  return value;
}

async function createLayer(
  manager: EntityManager,
  movement: FifoMovementRow,
  input: {
    quantity: bigint;
    unitCost: string;
    currency: string;
    origin: LayerOrigin;
    acquiredAt: Date | string;
    mode: AllocationMode;
    sourceLayerId?: string;
    purchaseReceiptLineId?: string;
    sourceAllocationId?: string;
  },
): Promise<bigint> {
  await assertCurrency(manager, movement, input.currency);
  const layerId = randomUUID();
  await manager.query(
    `INSERT INTO inventory_fifo_layers
       (id, tenant_id, product_id, location_id, source_movement_id,
        source_layer_id, purchase_receipt_line_id, origin_type,
        original_quantity, remaining_quantity, unit_cost, currency, acquired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      layerId,
      movement.tenant_id,
      movement.product_id,
      movement.location_id,
      movement.id,
      input.sourceLayerId ?? null,
      input.purchaseReceiptLineId ?? null,
      input.origin,
      quantityDecimal(input.quantity),
      quantityDecimal(input.quantity),
      input.unitCost,
      input.currency,
      input.acquiredAt,
    ],
  );
  return insertAllocation(manager, movement, {
    layerId,
    quantity: input.quantity,
    unitCost: input.unitCost,
    currency: input.currency,
    mode: input.mode,
    sourceAllocationId: input.sourceAllocationId,
  });
}

async function sourceCost(
  manager: EntityManager,
  movement: FifoMovementRow,
): Promise<{ unitCost: string; currency: string }> {
  if (movement.type === 'PURCHASE_RECEIPT') {
    const [source] = await manager.query<
      Array<{ unit_cost: string; currency: string }>
    >(
      `SELECT prl.unit_cost, po.currency
       FROM purchase_receipt_lines prl
       INNER JOIN purchase_receipts pr
         ON pr.id = prl.receipt_id AND pr.tenant_id = prl.tenant_id
       INNER JOIN purchase_orders po
         ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
       WHERE prl.id = ? AND prl.tenant_id = ?`,
      [movement.purchase_receipt_line_id, movement.tenant_id],
    );
    if (!source) throw new Error('FIFO_PURCHASE_RECEIPT_COST_NOT_FOUND');
    return { unitCost: source.unit_cost, currency: source.currency };
  }
  if (!movement.unit_cost) throw new Error('FIFO_MOVEMENT_COST_NOT_FOUND');
  return {
    unitCost: movement.unit_cost,
    currency: tenantCurrency(movement.country_code),
  };
}

async function consumeLayers(
  manager: EntityManager,
  movement: FifoMovementRow,
  requestedQuantity: bigint,
  source: { receiptLineId?: string; transferLineId?: string } = {},
): Promise<bigint> {
  const parameters: unknown[] = [
    movement.tenant_id,
    movement.product_id,
    movement.location_id,
  ];
  let sourceFilter = '';
  if (source.receiptLineId) {
    sourceFilter = 'AND purchase_receipt_line_id = ?';
    parameters.push(source.receiptLineId);
  } else if (source.transferLineId) {
    sourceFilter = `AND source_movement_id IN (
      SELECT id FROM inventory_movements
      WHERE tenant_id = ? AND transfer_line_id = ? AND type = 'TRANSFER_IN'
    )`;
    parameters.push(movement.tenant_id, source.transferLineId);
  }
  const layers = await manager.query<FifoLayerRow[]>(
    `SELECT id, remaining_quantity, unit_cost, currency, acquired_at
     FROM inventory_fifo_layers
     WHERE tenant_id = ? AND product_id = ? AND location_id = ?
       AND remaining_quantity > 0 ${sourceFilter}
     ORDER BY acquired_at, created_at, id
     FOR UPDATE`,
    parameters,
  );
  let remaining = requestedQuantity;
  let totalValue = 0n;
  for (const layer of layers) {
    if (remaining === 0n) break;
    const available = quantityUnits(layer.remaining_quantity);
    const consumed = available < remaining ? available : remaining;
    if (consumed === 0n) continue;
    await manager.query(
      `UPDATE inventory_fifo_layers
       SET remaining_quantity = ?, version = version + 1
       WHERE id = ? AND tenant_id = ?`,
      [quantityDecimal(available - consumed), layer.id, movement.tenant_id],
    );
    totalValue += await insertAllocation(manager, movement, {
      layerId: layer.id,
      quantity: -consumed,
      unitCost: layer.unit_cost,
      currency: layer.currency,
      mode: source.receiptLineId ? 'ORIGIN_RETURN' : 'FIFO',
    });
    remaining -= consumed;
  }
  if (remaining !== 0n) throw new InventoryFifoLayerShortageError();
  return totalValue;
}

async function restoreSale(
  manager: EntityManager,
  movement: FifoMovementRow,
  expectedQuantity: bigint,
): Promise<bigint> {
  const allocations = await manager.query<SourceAllocationRow[]>(
    `SELECT imfl.id, imfl.layer_id, imfl.quantity_change,
            imfl.unit_cost, imfl.currency, layer.acquired_at
     FROM inventory_movement_fifo_layers imfl
     INNER JOIN inventory_movements im
       ON im.id = imfl.movement_id AND im.tenant_id = imfl.tenant_id
     INNER JOIN inventory_fifo_layers layer
       ON layer.id = imfl.layer_id AND layer.tenant_id = imfl.tenant_id
     WHERE im.tenant_id = ? AND im.sale_id = ? AND im.sale_line_id = ?
       AND im.location_id = ? AND im.type = 'SALE'
     ORDER BY im.created_at, im.id, imfl.created_at, imfl.id
     FOR UPDATE`,
    [
      movement.tenant_id,
      movement.sale_id,
      movement.sale_line_id,
      movement.location_id,
    ],
  );
  let restored = 0n;
  let totalValue = 0n;
  for (const allocation of allocations) {
    const quantity = -quantityUnits(allocation.quantity_change);
    if (quantity <= 0n) continue;
    const [layer] = await manager.query<
      Array<{ original_quantity: string; remaining_quantity: string }>
    >(
      `SELECT original_quantity, remaining_quantity
       FROM inventory_fifo_layers
       WHERE id = ? AND tenant_id = ? FOR UPDATE`,
      [allocation.layer_id, movement.tenant_id],
    );
    if (!layer) throw new InventoryFifoLayerShortageError();
    const next = quantityUnits(layer.remaining_quantity) + quantity;
    if (next > quantityUnits(layer.original_quantity)) {
      throw new InventoryFifoLayerShortageError();
    }
    await manager.query(
      `UPDATE inventory_fifo_layers
       SET remaining_quantity = ?, version = version + 1
       WHERE id = ? AND tenant_id = ?`,
      [quantityDecimal(next), allocation.layer_id, movement.tenant_id],
    );
    totalValue += await insertAllocation(manager, movement, {
      layerId: allocation.layer_id,
      quantity,
      unitCost: allocation.unit_cost,
      currency: allocation.currency,
      mode: 'RESTORE',
      sourceAllocationId: allocation.id,
    });
    restored += quantity;
  }
  if (restored !== expectedQuantity) {
    throw new InventoryFifoLayerShortageError();
  }
  return totalValue;
}

async function transferLayers(
  manager: EntityManager,
  movement: FifoMovementRow,
  expectedQuantity: bigint,
): Promise<bigint> {
  const allocations = await manager.query<SourceAllocationRow[]>(
    `SELECT imfl.id, imfl.layer_id, imfl.quantity_change,
            imfl.unit_cost, imfl.currency, layer.acquired_at
     FROM inventory_movement_fifo_layers imfl
     INNER JOIN inventory_movements im
       ON im.id = imfl.movement_id AND im.tenant_id = imfl.tenant_id
     INNER JOIN inventory_fifo_layers layer
       ON layer.id = imfl.layer_id AND layer.tenant_id = imfl.tenant_id
     WHERE im.tenant_id = ? AND im.transfer_line_id = ?
       AND im.type = 'TRANSFER_OUT'
     ORDER BY im.created_at, im.id, imfl.created_at, imfl.id
     FOR UPDATE`,
    [movement.tenant_id, movement.transfer_line_id],
  );
  let transferred = 0n;
  let totalValue = 0n;
  for (const allocation of allocations) {
    const quantity = -quantityUnits(allocation.quantity_change);
    if (quantity <= 0n) continue;
    totalValue += await createLayer(manager, movement, {
      quantity,
      unitCost: allocation.unit_cost,
      currency: allocation.currency,
      origin: 'TRANSFER',
      acquiredAt: allocation.acquired_at,
      mode: 'TRANSFER',
      sourceLayerId: allocation.layer_id,
      sourceAllocationId: allocation.id,
    });
    transferred += quantity;
  }
  if (transferred !== expectedQuantity) {
    throw new InventoryFifoLayerShortageError();
  }
  return totalValue;
}

async function receiptLineForReturn(
  manager: EntityManager,
  movement: FifoMovementRow,
): Promise<string> {
  const [source] = await manager.query<
    Array<{ purchase_receipt_line_id: string }>
  >(
    `SELECT purchase_receipt_line_id
     FROM purchase_return_lines
     WHERE id = ? AND tenant_id = ?`,
    [movement.purchase_return_line_id, movement.tenant_id],
  );
  if (!source) throw new Error('FIFO_RETURN_SOURCE_NOT_FOUND');
  return source.purchase_receipt_line_id;
}

async function updateMovementSummary(
  manager: EntityManager,
  movement: FifoMovementRow,
  quantityChange: bigint,
  valueChange: bigint,
): Promise<void> {
  const [totals] = await manager.query<
    Array<{ quantity: string; inventory_value: string }>
  >(
    `SELECT COALESCE(SUM(remaining_quantity), 0) AS quantity,
            COALESCE(SUM(remaining_quantity * unit_cost), 0) AS inventory_value
     FROM inventory_fifo_layers
     WHERE tenant_id = ? AND product_id = ?`,
    [movement.tenant_id, movement.product_id],
  );
  const [valuation] = await manager.query<Array<{ quantity: string }>>(
    `SELECT quantity FROM inventory_valuations
     WHERE tenant_id = ? AND product_id = ?`,
    [movement.tenant_id, movement.product_id],
  );
  if (
    !valuation ||
    quantityUnits(totals.quantity) !== quantityUnits(valuation.quantity)
  ) {
    throw new InventoryFifoLayerShortageError();
  }
  const weightedUnitCost =
    quantityChange === 0n
      ? 0n
      : divideRounded(
          (valueChange < 0n ? -valueChange : valueChange) * QUANTITY_SCALE,
          quantityChange < 0n ? -quantityChange : quantityChange,
        );
  await manager.query(
    `UPDATE inventory_movements
     SET fifo_unit_cost = ?, fifo_value_change = ?,
         fifo_resulting_inventory_value = ?
     WHERE id = ? AND tenant_id = ?`,
    [
      costDecimal(weightedUnitCost),
      costDecimal(valueChange),
      totals.inventory_value,
      movement.id,
      movement.tenant_id,
    ],
  );
}

/**
 * Maintains a FIFO projection beside the active moving-average valuation.
 * Existing stock starts at the migration cut using its moving-average cost;
 * method activation and future cutovers remain the responsibility of UIN-117.
 */
export async function applyInventoryFifoValuation(
  manager: EntityManager,
  movementId: string,
): Promise<void> {
  const [movement] = await manager.query<FifoMovementRow[]>(
    `SELECT im.id, im.tenant_id, im.product_id, im.location_id, im.type,
            im.quantity_change, im.purchase_receipt_line_id,
            im.purchase_return_line_id, im.sale_id, im.sale_line_id,
            im.transfer_line_id, im.unit_cost, im.created_at, t.country_code
     FROM inventory_movements im
     INNER JOIN tenants t ON t.id = im.tenant_id
     WHERE im.id = ?`,
    [movementId],
  );
  if (!movement) throw new Error('INVENTORY_MOVEMENT_NOT_FOUND_FOR_FIFO');
  const [existing] = await manager.query<Array<{ total: number | string }>>(
    `SELECT COUNT(*) AS total FROM inventory_movement_fifo_layers
     WHERE tenant_id = ? AND movement_id = ?`,
    [movement.tenant_id, movement.id],
  );
  if (Number(existing.total) > 0) return;

  await manager.query(
    `SELECT id FROM products
     WHERE id = ? AND tenant_id = ? FOR UPDATE`,
    [movement.product_id, movement.tenant_id],
  );
  await ensureCutover(manager, movement);
  const quantityChange = quantityUnits(movement.quantity_change);
  let valueChange = 0n;
  if (quantityChange > 0n) {
    if (movement.type === 'SALE_VOID') {
      valueChange = await restoreSale(manager, movement, quantityChange);
    } else if (movement.type === 'TRANSFER_IN') {
      valueChange = await transferLayers(manager, movement, quantityChange);
    } else {
      const cost = await sourceCost(manager, movement);
      valueChange = await createLayer(manager, movement, {
        quantity: quantityChange,
        unitCost: cost.unitCost,
        currency: cost.currency,
        origin:
          movement.type === 'PURCHASE_RECEIPT'
            ? 'PURCHASE_RECEIPT'
            : movement.type === 'RETURN'
              ? 'RETURN'
              : 'ENTRY',
        acquiredAt: movement.created_at,
        mode: 'ENTRY',
        purchaseReceiptLineId: movement.purchase_receipt_line_id ?? undefined,
      });
    }
  } else if (quantityChange < 0n) {
    const receiptLineId =
      movement.type === 'SUPPLIER_RETURN'
        ? await receiptLineForReturn(manager, movement)
        : undefined;
    valueChange = await consumeLayers(manager, movement, -quantityChange, {
      receiptLineId,
      transferLineId:
        movement.type === 'TRANSFER_DISCREPANCY'
          ? (movement.transfer_line_id ?? undefined)
          : undefined,
    });
  }
  await updateMovementSummary(manager, movement, quantityChange, valueChange);
}

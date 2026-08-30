import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import {
  InsufficientInventoryLotStockError,
  InvalidInventoryLotCodeError,
  InventoryLotCurrencyMismatchError,
  InvalidInventoryLotDatesError,
  InventoryLotExpirationRequiredError,
  InventoryLotNotFoundError,
  InventoryLotRequiredError,
  ExpiredInventoryLotError,
} from './inventory.errors';
import { finalizeSpecificLotMovementValuation } from './inventory-valuation-policy';

type SelectionMode = 'ORIGIN' | 'MANUAL' | 'AUTOMATIC' | 'RESTORE' | 'TRANSFER';

interface MovementLotRow {
  id: string;
  tenant_id: string;
  product_id: string;
  location_id: string;
  type: string;
  quantity_change: string;
  created_by_user_id: string;
  purchase_receipt_line_id: string | null;
  purchase_return_line_id: string | null;
  sale_id: string | null;
  sale_line_id: string | null;
  source_sale_movement_id: string | null;
  transfer_line_id: string | null;
  track_lots: number | boolean;
  lot_expiration_policy: 'NONE' | 'OPTIONAL' | 'REQUIRED';
  unit_cost: string | null;
  country_code: string;
  timezone: string;
}

interface LotBalanceRow {
  lot_id: string;
  quantity: string;
  expires_on: string | Date | null;
}

const SCALE = 1000n;
const COST_SCALE = 10000n;

interface LotCostSource {
  unitCost: string;
  currency: string;
  revalue: boolean;
}

function units(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(3, '0'));
  return negative ? -result : result;
}

function decimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / SCALE}.${String(absolute % SCALE).padStart(3, '0')}`;
}

function costUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = String(value).trim().split('.');
  return (
    BigInt(whole || '0') * COST_SCALE +
    BigInt(fraction.padEnd(4, '0').slice(0, 4))
  );
}

function costDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / COST_SCALE}.${String(absolute % COST_SCALE).padStart(4, '0')}`;
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('INVALID_LOT_COST_DIVISOR');
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function quantityValue(quantity: bigint, unitCost: bigint): bigint {
  return divideRounded(quantity * unitCost, SCALE);
}

function currencyFor(countryCode: string): string {
  if (countryCode === 'MX') return 'MXN';
  if (countryCode === 'CL') return 'CLP';
  return 'USD';
}

function normalizeLotCode(value: string): string {
  const code = value.trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/ -]{0,63}$/.test(code)) {
    throw new InvalidInventoryLotCodeError();
  }
  return code;
}

function normalizedDate(value?: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new InvalidInventoryLotDatesError();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new InvalidInventoryLotDatesError();
  return value;
}

export function inventoryLocalDate(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function rowDate(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

async function changeLotBalance(
  manager: EntityManager,
  movement: MovementLotRow,
  lotId: string,
  quantityChange: bigint,
  mode: SelectionMode,
  costSource?: LotCostSource,
): Promise<void> {
  const [lot] = await manager.query<
    Array<{ unit_cost: string; currency: string }>
  >(
    `SELECT unit_cost, currency FROM inventory_lots
     WHERE id = ? AND tenant_id = ? FOR UPDATE`,
    [lotId, movement.tenant_id],
  );
  if (!lot) throw new InventoryLotNotFoundError();
  if (costSource && costSource.currency !== lot.currency) {
    throw new InventoryLotCurrencyMismatchError();
  }
  await manager.query(
    `INSERT INTO inventory_lot_balances
       (tenant_id, lot_id, location_id, quantity)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE lot_id = VALUES(lot_id)`,
    [movement.tenant_id, lotId, movement.location_id],
  );
  const [balance] = await manager.query<Array<{ quantity: string }>>(
    `SELECT quantity FROM inventory_lot_balances
     WHERE tenant_id = ? AND lot_id = ? AND location_id = ? FOR UPDATE`,
    [movement.tenant_id, lotId, movement.location_id],
  );
  const balances = await manager.query<Array<{ quantity: string }>>(
    `SELECT quantity FROM inventory_lot_balances
     WHERE tenant_id = ? AND lot_id = ? FOR UPDATE`,
    [movement.tenant_id, lotId],
  );
  const currentTotal = balances.reduce(
    (total, item) => total + units(item.quantity),
    0n,
  );
  const resulting = units(balance.quantity) + quantityChange;
  if (resulting < 0n) throw new InsufficientInventoryLotStockError();
  const currentCost = costUnits(lot.unit_cost);
  const allocationCost = costSource
    ? costUnits(costSource.unitCost)
    : currentCost;
  const newTotal = currentTotal + quantityChange;
  if (costSource?.revalue && newTotal > 0n) {
    const newCost = divideRounded(
      currentTotal * currentCost + quantityChange * allocationCost,
      newTotal,
    );
    if (newCost < 0n) throw new Error('NEGATIVE_INVENTORY_LOT_COST');
    await manager.query(
      `UPDATE inventory_lots SET unit_cost = ?
       WHERE id = ? AND tenant_id = ?`,
      [costDecimal(newCost), lotId, movement.tenant_id],
    );
  }
  await manager.query(
    `UPDATE inventory_lot_balances SET quantity = ?
     WHERE tenant_id = ? AND lot_id = ? AND location_id = ?`,
    [decimal(resulting), movement.tenant_id, lotId, movement.location_id],
  );
  await manager.query(
    `INSERT INTO inventory_movement_lots
       (id, tenant_id, movement_id, lot_id, location_id, quantity_change,
        unit_cost, currency, value_change, selection_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      movement.tenant_id,
      movement.id,
      lotId,
      movement.location_id,
      decimal(quantityChange),
      costDecimal(allocationCost),
      costSource?.currency ?? lot.currency,
      costDecimal(quantityValue(quantityChange, allocationCost)),
      mode,
    ],
  );
}

async function findOrCreateLot(
  manager: EntityManager,
  movement: MovementLotRow,
  rawCode: string,
  unitCost: string,
  currency: string,
  manufacturedOn?: string | null,
  expiresOn?: string | null,
): Promise<string> {
  const code = normalizeLotCode(rawCode);
  const normalizedCode = code.toUpperCase();
  const manufactured = normalizedDate(manufacturedOn);
  const expires = normalizedDate(expiresOn);
  if (manufactured && expires && manufactured > expires)
    throw new InvalidInventoryLotDatesError();
  const [product] = await manager.query<
    Array<{ lot_expiration_policy: 'NONE' | 'OPTIONAL' | 'REQUIRED' }>
  >(
    `SELECT lot_expiration_policy FROM products
     WHERE id = ? AND tenant_id = ? FOR UPDATE`,
    [movement.product_id, movement.tenant_id],
  );
  if (!product) throw new InventoryLotNotFoundError();
  if (product.lot_expiration_policy === 'REQUIRED' && !expires)
    throw new InventoryLotExpirationRequiredError();
  if (product.lot_expiration_policy === 'NONE' && (manufactured || expires))
    throw new InvalidInventoryLotDatesError();
  const [productCurrency] = await manager.query<Array<{ currency: string }>>(
    `SELECT currency FROM inventory_lots
     WHERE tenant_id = ? AND product_id = ?
     ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
    [movement.tenant_id, movement.product_id],
  );
  if (productCurrency && productCurrency.currency !== currency) {
    throw new InventoryLotCurrencyMismatchError();
  }
  const [existing] = await manager.query<
    Array<{
      id: string;
      currency: string;
      manufactured_on: string | Date | null;
      expires_on: string | Date | null;
    }>
  >(
    `SELECT id, currency, manufactured_on, expires_on FROM inventory_lots
     WHERE tenant_id = ? AND product_id = ? AND normalized_code = ?
     FOR UPDATE`,
    [movement.tenant_id, movement.product_id, normalizedCode],
  );
  if (existing) {
    if (existing.currency !== currency)
      throw new InventoryLotCurrencyMismatchError();
    if (
      rowDate(existing.manufactured_on) !== manufactured ||
      rowDate(existing.expires_on) !== expires
    )
      throw new InvalidInventoryLotDatesError();
    return existing.id;
  }
  const id = randomUUID();
  await manager.query(
    `INSERT INTO inventory_lots
       (id, tenant_id, product_id, code, normalized_code, manufactured_on,
        expires_on, unit_cost, currency, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      movement.tenant_id,
      movement.product_id,
      code,
      normalizedCode,
      manufactured,
      expires,
      unitCost,
      currency,
      movement.created_by_user_id,
    ],
  );
  return id;
}

async function restoreAllocations(
  manager: EntityManager,
  movement: MovementLotRow,
  sourceType: 'SALE' | 'TRANSFER_OUT',
  mode: 'RESTORE' | 'TRANSFER',
): Promise<void> {
  const isPartialSaleReturn =
    sourceType === 'SALE' && movement.type === 'SALE_RETURN';
  const parameters = isPartialSaleReturn
    ? [movement.tenant_id, movement.source_sale_movement_id]
    : sourceType === 'SALE'
      ? [
          movement.tenant_id,
          movement.sale_id,
          movement.sale_line_id,
          movement.location_id,
        ]
      : [movement.tenant_id, movement.transfer_line_id];
  const filter = isPartialSaleReturn
    ? 'im.id = ?'
    : sourceType === 'SALE'
      ? `im.sale_id = ? AND im.sale_line_id = ? AND im.location_id = ?`
      : `im.transfer_line_id = ?`;
  const allocations = await manager.query<
    Array<{
      source_movement_id: string;
      lot_id: string;
      quantity_change: string;
      unit_cost: string;
      currency: string;
    }>
  >(
    `SELECT im.id AS source_movement_id, iml.lot_id, iml.quantity_change,
            iml.unit_cost, iml.currency
     FROM inventory_movement_lots iml
     INNER JOIN inventory_movements im
       ON im.id = iml.movement_id AND im.tenant_id = iml.tenant_id
     WHERE im.tenant_id = ? AND ${filter} AND im.type = ?
     ORDER BY im.created_at, im.id, iml.created_at, iml.id`,
    [...parameters, sourceType],
  );
  if (allocations.length === 0)
    throw new Error('INVENTORY_LOT_SOURCE_NOT_FOUND');
  const expected = units(movement.quantity_change);
  let restored = 0n;
  let remaining = expected;
  for (const allocation of allocations) {
    if (remaining === 0n) break;
    const original = -units(allocation.quantity_change);
    let alreadyRestored = 0n;
    if (isPartialSaleReturn) {
      const [prior] = await manager.query<Array<{ quantity: string }>>(
        `SELECT COALESCE(SUM(return_lot.quantity_change), 0) AS quantity
         FROM inventory_movement_lots return_lot
         INNER JOIN inventory_movements return_movement
           ON return_movement.id = return_lot.movement_id
          AND return_movement.tenant_id = return_lot.tenant_id
         WHERE return_movement.tenant_id = ?
           AND return_movement.type = 'SALE_RETURN'
           AND return_movement.source_sale_movement_id = ?
           AND return_lot.lot_id = ?`,
        [movement.tenant_id, allocation.source_movement_id, allocation.lot_id],
      );
      alreadyRestored = units(prior.quantity);
    }
    const available = original - alreadyRestored;
    const quantity = available < remaining ? available : remaining;
    if (quantity <= 0n) continue;
    await changeLotBalance(
      manager,
      movement,
      allocation.lot_id,
      quantity,
      mode,
      {
        unitCost: allocation.unit_cost,
        currency: allocation.currency,
        revalue: true,
      },
    );
    restored += quantity;
    remaining -= quantity;
  }
  if (restored !== expected) throw new Error('INVENTORY_LOT_RESTORE_MISMATCH');
}

async function consumeLots(
  manager: EntityManager,
  movement: MovementLotRow,
  quantity: bigint,
  preferredLotId?: string,
  preferredLotCode?: string,
  costSource?: LotCostSource,
  allowExpired = false,
): Promise<void> {
  let balances: LotBalanceRow[];
  let mode: SelectionMode = 'AUTOMATIC';
  if (preferredLotId || preferredLotCode) {
    mode = 'MANUAL';
    const filters = preferredLotId ? 'il.id = ?' : 'il.normalized_code = ?';
    const value = preferredLotId
      ? preferredLotId
      : normalizeLotCode(preferredLotCode!).toUpperCase();
    balances = await manager.query<LotBalanceRow[]>(
      `SELECT ilb.lot_id, ilb.quantity, il.expires_on
       FROM inventory_lot_balances ilb
       INNER JOIN inventory_lots il
         ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
       WHERE ilb.tenant_id = ? AND il.product_id = ?
         AND ilb.location_id = ? AND ${filters}
       FOR UPDATE`,
      [movement.tenant_id, movement.product_id, movement.location_id, value],
    );
    if (balances.length === 0) throw new InventoryLotNotFoundError();
    const expiry = rowDate(balances[0].expires_on);
    if (
      expiry &&
      expiry < inventoryLocalDate(movement.timezone) &&
      !allowExpired
    )
      throw new ExpiredInventoryLotError();
  } else {
    balances = await manager.query<LotBalanceRow[]>(
      `SELECT ilb.lot_id, ilb.quantity, il.expires_on
       FROM inventory_lot_balances ilb
       INNER JOIN inventory_lots il
         ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
       WHERE ilb.tenant_id = ? AND il.product_id = ?
         AND ilb.location_id = ? AND ilb.quantity > 0
         AND (il.expires_on IS NULL OR il.expires_on >= ?)
       ORDER BY il.expires_on IS NULL, il.expires_on, il.created_at, il.id
       FOR UPDATE`,
      [
        movement.tenant_id,
        movement.product_id,
        movement.location_id,
        inventoryLocalDate(movement.timezone),
      ],
    );
  }
  let remaining = quantity;
  for (const balance of balances) {
    if (remaining === 0n) break;
    const available = units(balance.quantity);
    const consumed = available < remaining ? available : remaining;
    if (consumed === 0n) continue;
    await changeLotBalance(
      manager,
      movement,
      balance.lot_id,
      -consumed,
      mode,
      costSource,
    );
    remaining -= consumed;
  }
  if (remaining !== 0n) throw new InsufficientInventoryLotStockError();
}

export async function applyInventoryLotTracking(
  manager: EntityManager,
  movementId: string,
  options: {
    lotCode?: string;
    preferredLotId?: string;
    manufacturedOn?: string;
    expiresOn?: string;
    allowExpired?: boolean;
  } = {},
): Promise<void> {
  const [movement] = await manager.query<MovementLotRow[]>(
    `SELECT im.id, im.tenant_id, im.product_id, im.location_id, im.type,
            im.quantity_change, im.created_by_user_id,
            im.purchase_receipt_line_id, im.purchase_return_line_id,
            im.sale_id, im.sale_line_id, im.source_sale_movement_id,
            im.transfer_line_id, p.track_lots, p.lot_expiration_policy,
            im.unit_cost, t.country_code, b.timezone
     FROM inventory_movements im
     INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
     INNER JOIN tenants t ON t.id = im.tenant_id
     INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
     INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
     INNER JOIN branches b ON b.id = w.branch_id AND b.tenant_id = w.tenant_id
     WHERE im.id = ?`,
    [movementId],
  );
  if (!movement) return;
  if (!movement.track_lots) {
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }
  const [existing] = await manager.query<Array<{ total: number | string }>>(
    `SELECT COUNT(*) AS total FROM inventory_movement_lots
     WHERE tenant_id = ? AND movement_id = ?`,
    [movement.tenant_id, movement.id],
  );
  if (Number(existing.total) > 0) {
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }

  const quantityChange = units(movement.quantity_change);
  if (quantityChange === 0n) {
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }

  if (movement.type === 'PURCHASE_RECEIPT') {
    const [line] = await manager.query<
      Array<{
        lot_code: string | null;
        manufactured_on: string | Date | null;
        expires_on: string | Date | null;
        unit_cost: string;
        currency: string;
      }>
    >(
      `SELECT prl.lot_code, prl.manufactured_on, prl.expires_on,
              prl.unit_cost, po.currency
       FROM purchase_receipt_lines prl
       INNER JOIN purchase_receipts pr
         ON pr.id = prl.receipt_id AND pr.tenant_id = prl.tenant_id
       INNER JOIN purchase_orders po
         ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
       WHERE prl.id = ? AND prl.tenant_id = ?`,
      [movement.purchase_receipt_line_id, movement.tenant_id],
    );
    if (!line?.lot_code) throw new InventoryLotRequiredError();
    const lotId = await findOrCreateLot(
      manager,
      movement,
      line.lot_code,
      line.unit_cost,
      line.currency,
      rowDate(line.manufactured_on),
      rowDate(line.expires_on),
    );
    await manager.query(
      `UPDATE purchase_receipt_lines SET lot_id = ?
       WHERE id = ? AND tenant_id = ?`,
      [lotId, movement.purchase_receipt_line_id, movement.tenant_id],
    );
    await manager.query(
      `INSERT INTO inventory_lot_origins
         (tenant_id, lot_id, purchase_receipt_line_id, quantity, unit_cost, currency)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        movement.tenant_id,
        lotId,
        movement.purchase_receipt_line_id,
        decimal(quantityChange),
        line.unit_cost,
        line.currency,
      ],
    );
    await changeLotBalance(manager, movement, lotId, quantityChange, 'ORIGIN', {
      unitCost: line.unit_cost,
      currency: line.currency,
      revalue: true,
    });
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }

  if (movement.type === 'SALE_VOID') {
    await restoreAllocations(manager, movement, 'SALE', 'RESTORE');
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }
  if (movement.type === 'SALE_RETURN') {
    await restoreAllocations(manager, movement, 'SALE', 'RESTORE');
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }
  if (movement.type === 'TRANSFER_IN') {
    await restoreAllocations(manager, movement, 'TRANSFER_OUT', 'TRANSFER');
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }

  if (quantityChange > 0n) {
    if (!options.lotCode) throw new InventoryLotRequiredError();
    if (!movement.unit_cost) throw new Error('INVENTORY_LOT_COST_NOT_FOUND');
    const currency = currencyFor(movement.country_code);
    const lotId = await findOrCreateLot(
      manager,
      movement,
      options.lotCode,
      movement.unit_cost,
      currency,
      options.manufacturedOn,
      options.expiresOn,
    );
    await changeLotBalance(manager, movement, lotId, quantityChange, 'MANUAL', {
      unitCost: movement.unit_cost,
      currency,
      revalue: true,
    });
    await finalizeSpecificLotMovementValuation(manager, movementId);
    return;
  }

  let preferredLotId = options.preferredLotId;
  let costSource: LotCostSource | undefined;
  if (movement.type === 'SUPPLIER_RETURN') {
    const [source] = await manager.query<
      Array<{
        lot_id: string | null;
        unit_cost: string;
        currency: string;
      }>
    >(
      `SELECT prl.lot_id, prl.unit_cost, po.currency
       FROM purchase_return_lines prtn
       INNER JOIN purchase_receipt_lines prl
         ON prl.id = prtn.purchase_receipt_line_id
        AND prl.tenant_id = prtn.tenant_id
       INNER JOIN purchase_receipts pr
         ON pr.id = prl.receipt_id AND pr.tenant_id = prl.tenant_id
       INNER JOIN purchase_orders po
         ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
       WHERE prtn.id = ? AND prtn.tenant_id = ?`,
      [movement.purchase_return_line_id, movement.tenant_id],
    );
    if (!source?.lot_id) throw new Error('INVENTORY_LOT_SOURCE_NOT_FOUND');
    preferredLotId = source.lot_id;
    costSource = {
      unitCost: source.unit_cost,
      currency: source.currency,
      revalue: false,
    };
    await manager.query(
      `UPDATE purchase_return_lines SET lot_id = ?
       WHERE id = ? AND tenant_id = ?`,
      [preferredLotId, movement.purchase_return_line_id, movement.tenant_id],
    );
  }
  await consumeLots(
    manager,
    movement,
    -quantityChange,
    preferredLotId,
    options.lotCode,
    costSource,
    options.allowExpired || movement.type === 'SUPPLIER_RETURN',
  );
  await finalizeSpecificLotMovementValuation(manager, movementId);
}

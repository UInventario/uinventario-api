import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import {
  InsufficientInventoryLotStockError,
  InvalidInventoryLotCodeError,
  InventoryLotNotFoundError,
  InventoryLotRequiredError,
} from './inventory.errors';

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
  transfer_line_id: string | null;
  track_lots: number | boolean;
}

interface LotBalanceRow {
  lot_id: string;
  quantity: string;
}

const SCALE = 1000n;

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

function normalizeLotCode(value: string): string {
  const code = value.trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/ -]{0,63}$/.test(code)) {
    throw new InvalidInventoryLotCodeError();
  }
  return code;
}

async function changeLotBalance(
  manager: EntityManager,
  movement: MovementLotRow,
  lotId: string,
  quantityChange: bigint,
  mode: SelectionMode,
): Promise<void> {
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
  const resulting = units(balance.quantity) + quantityChange;
  if (resulting < 0n) throw new InsufficientInventoryLotStockError();
  await manager.query(
    `UPDATE inventory_lot_balances SET quantity = ?
     WHERE tenant_id = ? AND lot_id = ? AND location_id = ?`,
    [decimal(resulting), movement.tenant_id, lotId, movement.location_id],
  );
  await manager.query(
    `INSERT INTO inventory_movement_lots
       (id, tenant_id, movement_id, lot_id, location_id, quantity_change,
        selection_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      movement.tenant_id,
      movement.id,
      lotId,
      movement.location_id,
      decimal(quantityChange),
      mode,
    ],
  );
}

async function findOrCreateLot(
  manager: EntityManager,
  movement: MovementLotRow,
  rawCode: string,
): Promise<string> {
  const code = normalizeLotCode(rawCode);
  const normalizedCode = code.toUpperCase();
  const [existing] = await manager.query<Array<{ id: string }>>(
    `SELECT id FROM inventory_lots
     WHERE tenant_id = ? AND product_id = ? AND normalized_code = ?
     FOR UPDATE`,
    [movement.tenant_id, movement.product_id, normalizedCode],
  );
  if (existing) return existing.id;
  const id = randomUUID();
  await manager.query(
    `INSERT INTO inventory_lots
       (id, tenant_id, product_id, code, normalized_code, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      movement.tenant_id,
      movement.product_id,
      code,
      normalizedCode,
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
  const parameters =
    sourceType === 'SALE'
      ? [
          movement.tenant_id,
          movement.sale_id,
          movement.sale_line_id,
          movement.location_id,
        ]
      : [movement.tenant_id, movement.transfer_line_id];
  const filter =
    sourceType === 'SALE'
      ? `im.sale_id = ? AND im.sale_line_id = ? AND im.location_id = ?`
      : `im.transfer_line_id = ?`;
  const allocations = await manager.query<
    Array<{ lot_id: string; quantity_change: string }>
  >(
    `SELECT iml.lot_id, iml.quantity_change
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
  for (const allocation of allocations) {
    const quantity = -units(allocation.quantity_change);
    await changeLotBalance(
      manager,
      movement,
      allocation.lot_id,
      quantity,
      mode,
    );
    restored += quantity;
  }
  if (restored !== expected) throw new Error('INVENTORY_LOT_RESTORE_MISMATCH');
}

async function consumeLots(
  manager: EntityManager,
  movement: MovementLotRow,
  quantity: bigint,
  preferredLotId?: string,
  preferredLotCode?: string,
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
      `SELECT ilb.lot_id, ilb.quantity
       FROM inventory_lot_balances ilb
       INNER JOIN inventory_lots il
         ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
       WHERE ilb.tenant_id = ? AND il.product_id = ?
         AND ilb.location_id = ? AND ${filters}
       FOR UPDATE`,
      [movement.tenant_id, movement.product_id, movement.location_id, value],
    );
    if (balances.length === 0) throw new InventoryLotNotFoundError();
  } else {
    balances = await manager.query<LotBalanceRow[]>(
      `SELECT ilb.lot_id, ilb.quantity
       FROM inventory_lot_balances ilb
       INNER JOIN inventory_lots il
         ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
       WHERE ilb.tenant_id = ? AND il.product_id = ?
         AND ilb.location_id = ? AND ilb.quantity > 0
       ORDER BY il.created_at, il.id
       FOR UPDATE`,
      [movement.tenant_id, movement.product_id, movement.location_id],
    );
  }
  let remaining = quantity;
  for (const balance of balances) {
    if (remaining === 0n) break;
    const available = units(balance.quantity);
    const consumed = available < remaining ? available : remaining;
    if (consumed === 0n) continue;
    await changeLotBalance(manager, movement, balance.lot_id, -consumed, mode);
    remaining -= consumed;
  }
  if (remaining !== 0n) throw new InsufficientInventoryLotStockError();
}

export async function applyInventoryLotTracking(
  manager: EntityManager,
  movementId: string,
  options: { lotCode?: string; preferredLotId?: string } = {},
): Promise<void> {
  const [movement] = await manager.query<MovementLotRow[]>(
    `SELECT im.id, im.tenant_id, im.product_id, im.location_id, im.type,
            im.quantity_change, im.created_by_user_id,
            im.purchase_receipt_line_id, im.purchase_return_line_id,
            im.sale_id, im.sale_line_id, im.transfer_line_id, p.track_lots
     FROM inventory_movements im
     INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
     WHERE im.id = ?`,
    [movementId],
  );
  if (!movement || !movement.track_lots) return;
  const [existing] = await manager.query<Array<{ total: number | string }>>(
    `SELECT COUNT(*) AS total FROM inventory_movement_lots
     WHERE tenant_id = ? AND movement_id = ?`,
    [movement.tenant_id, movement.id],
  );
  if (Number(existing.total) > 0) return;

  const quantityChange = units(movement.quantity_change);
  if (quantityChange === 0n) return;

  if (movement.type === 'PURCHASE_RECEIPT') {
    const [line] = await manager.query<
      Array<{ lot_code: string | null; unit_cost: string; currency: string }>
    >(
      `SELECT prl.lot_code, prl.unit_cost, po.currency
       FROM purchase_receipt_lines prl
       INNER JOIN purchase_receipts pr
         ON pr.id = prl.receipt_id AND pr.tenant_id = prl.tenant_id
       INNER JOIN purchase_orders po
         ON po.id = pr.purchase_order_id AND po.tenant_id = pr.tenant_id
       WHERE prl.id = ? AND prl.tenant_id = ?`,
      [movement.purchase_receipt_line_id, movement.tenant_id],
    );
    if (!line?.lot_code) throw new InventoryLotRequiredError();
    const lotId = await findOrCreateLot(manager, movement, line.lot_code);
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
    await changeLotBalance(manager, movement, lotId, quantityChange, 'ORIGIN');
    return;
  }

  if (movement.type === 'SALE_VOID') {
    await restoreAllocations(manager, movement, 'SALE', 'RESTORE');
    return;
  }
  if (movement.type === 'TRANSFER_IN') {
    await restoreAllocations(manager, movement, 'TRANSFER_OUT', 'TRANSFER');
    return;
  }

  if (quantityChange > 0n) {
    if (!options.lotCode) throw new InventoryLotRequiredError();
    const lotId = await findOrCreateLot(manager, movement, options.lotCode);
    await changeLotBalance(manager, movement, lotId, quantityChange, 'MANUAL');
    return;
  }

  let preferredLotId = options.preferredLotId;
  if (movement.type === 'SUPPLIER_RETURN') {
    const [source] = await manager.query<Array<{ lot_id: string | null }>>(
      `SELECT prl.lot_id
       FROM purchase_return_lines prtn
       INNER JOIN purchase_receipt_lines prl
         ON prl.id = prtn.purchase_receipt_line_id
        AND prl.tenant_id = prtn.tenant_id
       WHERE prtn.id = ? AND prtn.tenant_id = ?`,
      [movement.purchase_return_line_id, movement.tenant_id],
    );
    if (!source?.lot_id) throw new Error('INVENTORY_LOT_SOURCE_NOT_FOUND');
    preferredLotId = source.lot_id;
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
  );
}

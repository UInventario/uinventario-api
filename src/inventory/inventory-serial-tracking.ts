import { randomUUID } from 'node:crypto';
import { EntityManager, QueryFailedError } from 'typeorm';

export type InventorySerialStatus =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'DAMAGED'
  | 'IN_TRANSIT'
  | 'SOLD'
  | 'RETURNED_TO_SUPPLIER'
  | 'REMOVED';

export class InventorySerialRequiredError extends Error {}
export class InventorySerialQuantityError extends Error {}
export class InventorySerialDuplicateError extends Error {}
export class InventorySerialNotFoundError extends Error {}
export class InventorySerialStateConflictError extends Error {}

interface MovementRow {
  id: string;
  tenant_id: string;
  product_id: string;
  location_id: string;
  type: string;
  quantity_change: string;
  state_quantity: string | null;
  from_state: string | null;
  to_state: string | null;
  created_by_user_id: string;
  sale_id: string | null;
  sale_line_id: string | null;
  sale_return_line_id: string | null;
  source_sale_movement_id: string | null;
  transfer_line_id: string | null;
  reservation_id: string | null;
  purchase_return_line_id: string | null;
  track_serials: number | boolean;
}

interface SerialRow {
  id: string;
  serial_number: string;
  status: InventorySerialStatus;
  current_location_id: string | null;
}

const normalize = (value: string) => value.trim().toUpperCase();

function units(value: string | null): bigint {
  if (!value || !/^-?\d+(?:\.\d+)?$/.test(value))
    throw new InventorySerialQuantityError();
  const [whole, fraction = ''] = value.split('.');
  if (fraction.replace(/0/g, '') !== '')
    throw new InventorySerialQuantityError();
  return BigInt(whole);
}

function requestedSerials(values: string[] | undefined, count: bigint) {
  const serials = (values ?? []).map((serialNumber) => ({
    serialNumber: serialNumber.trim(),
    normalized: normalize(serialNumber),
  }));
  if (
    count < 0n ||
    count > 1000n ||
    serials.length !== Number(count) ||
    serials.some(
      ({ serialNumber, normalized }) =>
        !serialNumber || !normalized || serialNumber.length > 120,
    ) ||
    new Set(serials.map(({ normalized }) => normalized)).size !== serials.length
  ) {
    throw new InventorySerialRequiredError();
  }
  return serials;
}

function isDuplicate(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string }).code === 'ER_DUP_ENTRY'
  );
}

async function appendEvent(
  manager: EntityManager,
  movement: MovementRow,
  serial: SerialRow,
  toStatus: InventorySerialStatus,
  toLocationId: string | null,
) {
  await manager.query(
    `INSERT INTO inventory_serial_events
       (id, tenant_id, serial_id, movement_id, from_status, to_status,
        from_location_id, to_location_id, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      movement.tenant_id,
      serial.id,
      movement.id,
      serial.status,
      toStatus,
      serial.current_location_id,
      toLocationId,
      movement.created_by_user_id,
    ],
  );
  await manager.query(
    `UPDATE inventory_serials
     SET status = ?, current_location_id = ?
     WHERE id = ? AND tenant_id = ?`,
    [toStatus, toLocationId, serial.id, movement.tenant_id],
  );
}

async function selectSerials(
  manager: EntityManager,
  movement: MovementRow,
  serialNumbers: string[],
): Promise<SerialRow[]> {
  const normalized = serialNumbers.map(normalize).sort();
  if (new Set(normalized).size !== normalized.length)
    throw new InventorySerialDuplicateError();
  const rows: SerialRow[] = [];
  for (const value of normalized) {
    const [row] = await manager.query<SerialRow[]>(
      `SELECT id, serial_number, status, current_location_id
       FROM inventory_serials
       WHERE tenant_id = ? AND product_id = ? AND normalized_serial = ?
       FOR UPDATE`,
      [movement.tenant_id, movement.product_id, value],
    );
    if (!row) throw new InventorySerialNotFoundError();
    rows.push(row);
  }
  return rows;
}

async function sourceSerials(
  manager: EntityManager,
  movement: MovementRow,
  sourceType: 'SALE' | 'TRANSFER_OUT',
): Promise<string[]> {
  const sourceFilter =
    sourceType === 'SALE'
      ? 'source.sale_id = ? AND source.sale_line_id = ?'
      : 'source.transfer_line_id = ?';
  const params =
    sourceType === 'SALE'
      ? [movement.sale_id, movement.sale_line_id]
      : [movement.transfer_line_id];
  const rows = await manager.query<Array<{ serial_number: string }>>(
    `SELECT serial.serial_number
     FROM inventory_movements source
     INNER JOIN inventory_serial_events event
       ON event.movement_id = source.id AND event.tenant_id = source.tenant_id
     INNER JOIN inventory_serials serial
       ON serial.id = event.serial_id AND serial.tenant_id = event.tenant_id
     WHERE source.tenant_id = ? AND source.product_id = ?
       AND source.type = ? AND ${sourceFilter}
     ORDER BY serial.normalized_serial`,
    [movement.tenant_id, movement.product_id, sourceType, ...params],
  );
  return rows.map(({ serial_number }) => serial_number);
}

async function registerSerials(
  manager: EntityManager,
  movement: MovementRow,
  serialNumbers: string[],
  toStatus: InventorySerialStatus,
) {
  for (const { serialNumber, normalized } of requestedSerials(
    serialNumbers,
    BigInt(serialNumbers.length),
  )) {
    const serial: SerialRow = {
      id: randomUUID(),
      serial_number: serialNumber,
      status: toStatus,
      current_location_id: movement.location_id,
    };
    try {
      await manager.query(
        `INSERT INTO inventory_serials
           (id, tenant_id, product_id, serial_number, normalized_serial,
            status, current_location_id, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          serial.id,
          movement.tenant_id,
          movement.product_id,
          serial.serial_number,
          normalized,
          toStatus,
          movement.location_id,
          movement.created_by_user_id,
        ],
      );
      await manager.query(
        `INSERT INTO inventory_serial_events
           (id, tenant_id, serial_id, movement_id, from_status, to_status,
            from_location_id, to_location_id, created_by_user_id)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
        [
          randomUUID(),
          movement.tenant_id,
          serial.id,
          movement.id,
          toStatus,
          movement.location_id,
          movement.created_by_user_id,
        ],
      );
    } catch (error) {
      if (isDuplicate(error)) throw new InventorySerialDuplicateError();
      throw error;
    }
  }
}

export async function applyInventorySerialTracking(
  manager: EntityManager,
  movementId: string,
  options: { serialNumbers?: string[]; destinationLocationId?: string } = {},
): Promise<void> {
  const [movement] = await manager.query<MovementRow[]>(
    `SELECT im.id, im.tenant_id, im.product_id, im.location_id, im.type,
            im.quantity_change, im.state_quantity, im.from_state, im.to_state,
            im.created_by_user_id, im.sale_id, im.sale_line_id,
            im.sale_return_line_id, im.source_sale_movement_id,
            im.transfer_line_id, im.reservation_id,
            im.purchase_return_line_id, p.track_serials
     FROM inventory_movements im
     INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
     WHERE im.id = ?`,
    [movementId],
  );
  if (!movement || !movement.track_serials) return;

  const [existing] = await manager.query<Array<{ total: number | string }>>(
    `SELECT COUNT(*) AS total FROM inventory_serial_events
     WHERE tenant_id = ? AND movement_id = ?`,
    [movement.tenant_id, movement.id],
  );
  if (Number(existing.total) > 0 || movement.type === 'TRANSFER_IN') return;

  const quantity = units(movement.quantity_change);
  const stateQuantity = movement.state_quantity
    ? units(movement.state_quantity)
    : 0n;
  const count =
    stateQuantity > 0n ? stateQuantity : quantity < 0n ? -quantity : quantity;
  let serialNumbers = options.serialNumbers;

  if (movement.type === 'SALE_VOID') {
    serialNumbers = await sourceSerials(manager, movement, 'SALE');
  }
  if (
    (movement.type === 'TRANSFER_RECEIPT' ||
      movement.type === 'TRANSFER_DISCREPANCY') &&
    !serialNumbers
  ) {
    serialNumbers = await sourceSerials(manager, movement, 'TRANSFER_OUT');
  }
  const requested = requestedSerials(serialNumbers, count);

  if (
    quantity > 0n &&
    ['INITIAL', 'ENTRY', 'PURCHASE_RECEIPT', 'IMPORT', 'ADJUSTMENT'].includes(
      movement.type,
    )
  ) {
    await registerSerials(
      manager,
      movement,
      requested.map(({ serialNumber }) => serialNumber),
      'AVAILABLE',
    );
    return;
  }

  const rows = await selectSerials(
    manager,
    movement,
    requested.map(({ serialNumber }) => serialNumber),
  );
  for (const serial of rows) {
    if (movement.type === 'SUPPLIER_RETURN') {
      const [origin] = await manager.query<Array<{ valid: number | string }>>(
        `SELECT EXISTS(
           SELECT 1 FROM purchase_return_lines return_line
           INNER JOIN purchase_receipt_lines receipt_line
             ON receipt_line.id = return_line.purchase_receipt_line_id
            AND receipt_line.tenant_id = return_line.tenant_id
           INNER JOIN inventory_movements source
             ON source.purchase_receipt_line_id = receipt_line.id
            AND source.tenant_id = receipt_line.tenant_id
            AND source.type = 'PURCHASE_RECEIPT'
           INNER JOIN inventory_serial_events source_event
             ON source_event.movement_id = source.id
            AND source_event.tenant_id = source.tenant_id
           WHERE return_line.id = ? AND return_line.tenant_id = ?
             AND source_event.serial_id = ?
         ) AS valid`,
        [movement.purchase_return_line_id, movement.tenant_id, serial.id],
      );
      if (Number(origin.valid) !== 1)
        throw new InventorySerialStateConflictError();
    }
    let allowed: InventorySerialStatus[] = ['AVAILABLE'];
    let toStatus: InventorySerialStatus = 'REMOVED';
    let toLocationId: string | null = movement.location_id;
    switch (movement.type) {
      case 'SALE':
        allowed = movement.reservation_id ? ['RESERVED'] : ['AVAILABLE'];
        toStatus = 'SOLD';
        toLocationId = null;
        break;
      case 'SALE_VOID':
      case 'RETURN':
        allowed = ['SOLD', 'REMOVED'];
        toStatus = 'AVAILABLE';
        break;
      case 'SALE_RETURN': {
        const [returnLine] = await manager.query<
          Array<{ item_condition: 'SELLABLE' | 'DAMAGED' }>
        >(
          `SELECT item_condition FROM sale_return_lines
           WHERE id = ? AND tenant_id = ?`,
          [movement.sale_return_line_id, movement.tenant_id],
        );
        if (!returnLine) throw new InventorySerialStateConflictError();
        allowed = ['SOLD'];
        toStatus =
          returnLine.item_condition === 'DAMAGED' ? 'DAMAGED' : 'AVAILABLE';
        break;
      }
      case 'TRANSFER_OUT':
        toStatus = 'IN_TRANSIT';
        toLocationId = options.destinationLocationId ?? null;
        break;
      case 'TRANSFER_RECEIPT':
        allowed = ['IN_TRANSIT'];
        toStatus = 'AVAILABLE';
        break;
      case 'TRANSFER_DISCREPANCY':
        allowed = ['IN_TRANSIT'];
        toStatus = 'REMOVED';
        toLocationId = null;
        break;
      case 'SUPPLIER_RETURN':
        toStatus = 'RETURNED_TO_SUPPLIER';
        toLocationId = null;
        break;
      case 'STATE_TRANSITION':
        allowed = [movement.from_state as InventorySerialStatus];
        toStatus = movement.to_state as InventorySerialStatus;
        break;
      case 'DAMAGE':
        toStatus = 'DAMAGED';
        break;
      default:
        toStatus = 'REMOVED';
        toLocationId = null;
    }
    if (
      !allowed.includes(serial.status) ||
      (serial.current_location_id !== movement.location_id &&
        !['SALE_VOID', 'SALE_RETURN'].includes(movement.type))
    ) {
      throw new InventorySerialStateConflictError();
    }
    await appendEvent(manager, movement, serial, toStatus, toLocationId);
  }
}

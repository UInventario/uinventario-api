export class InventoryTransferNotFoundError extends Error {
  constructor() {
    super('INVENTORY_TRANSFER_NOT_FOUND');
  }
}

export class InvalidInventoryTransferTargetError extends Error {
  constructor() {
    super('INVALID_INVENTORY_TRANSFER_TARGET');
  }
}

export class DuplicateInventoryTransferLineError extends Error {
  constructor() {
    super('DUPLICATE_INVENTORY_TRANSFER_LINE');
  }
}

export class InventoryTransferIdempotencyConflictError extends Error {
  constructor() {
    super('INVENTORY_TRANSFER_IDEMPOTENCY_CONFLICT');
  }
}

export class InventoryTransferStatusConflictError extends Error {
  constructor() {
    super('INVENTORY_TRANSFER_STATUS_CONFLICT');
  }
}

export class InventoryTransferInsufficientStockError extends Error {
  constructor() {
    super('INVENTORY_TRANSFER_INSUFFICIENT_STOCK');
  }
}

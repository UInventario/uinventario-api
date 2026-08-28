export class InventoryTargetNotFoundError extends Error {
  constructor() {
    super('INVENTORY_TARGET_NOT_FOUND');
  }
}

export class InitialStockAlreadyExistsError extends Error {
  constructor() {
    super('INITIAL_STOCK_ALREADY_EXISTS');
  }
}

export class InsufficientStockError extends Error {
  constructor() {
    super('INSUFFICIENT_STOCK');
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('IDEMPOTENCY_KEY_REUSED');
  }
}

export class MovementReferenceRequiredError extends Error {
  constructor() {
    super('MOVEMENT_REFERENCE_REQUIRED');
  }
}

export class InvalidStockStateTransitionError extends Error {
  constructor() {
    super('INVALID_STOCK_STATE_TRANSITION');
  }
}

export class InsufficientStockStateError extends Error {
  constructor() {
    super('INSUFFICIENT_STOCK_STATE');
  }
}

export class InventoryCountConflictError extends Error {
  constructor(readonly currentQuantity: string) {
    super('INVENTORY_COUNT_CONFLICT');
  }
}

export class InvalidInventoryLotCodeError extends Error {
  constructor() {
    super('INVALID_INVENTORY_LOT_CODE');
  }
}

export class InventoryLotRequiredError extends Error {
  constructor() {
    super('INVENTORY_LOT_REQUIRED');
  }
}

export class InventoryLotNotFoundError extends Error {
  constructor() {
    super('INVENTORY_LOT_NOT_FOUND');
  }
}

export class InsufficientInventoryLotStockError extends Error {
  constructor() {
    super('INSUFFICIENT_INVENTORY_LOT_STOCK');
  }
}

export class InventoryLotCurrencyMismatchError extends Error {
  constructor() {
    super('INVENTORY_LOT_CURRENCY_MISMATCH');
  }
}

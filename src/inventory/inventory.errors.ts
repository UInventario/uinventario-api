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

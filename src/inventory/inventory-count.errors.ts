export class InventoryCountSessionNotFoundError extends Error {}
export class InventoryCountSessionClosedError extends Error {}
export class InventoryCountSessionIncompleteError extends Error {}

export class InventoryCountAttemptConflictError extends Error {
  constructor(readonly currentAttempt: number) {
    super('INVENTORY_COUNT_ATTEMPT_CONFLICT');
  }
}

export class InventoryCountStockChangedError extends Error {
  constructor(
    readonly productId: string,
    readonly currentQuantity: string,
  ) {
    super('INVENTORY_COUNT_STOCK_CHANGED');
  }
}

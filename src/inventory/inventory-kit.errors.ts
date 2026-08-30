export class InventoryKitNotFoundError extends Error {}
export class InventoryKitNotAssembledError extends Error {}
export class InventoryKitInsufficientStockError extends Error {
  constructor(readonly productId: string) {
    super('INVENTORY_KIT_INSUFFICIENT_STOCK');
  }
}
export class InventoryKitIdempotencyConflictError extends Error {}

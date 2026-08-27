export class PurchaseOrderReferenceError extends Error {
  constructor(
    readonly reference: 'SUPPLIER' | 'SUPPLIER_PRODUCT' | 'CURRENCY',
  ) {
    super(`PURCHASE_ORDER_INVALID_${reference}`);
  }
}

export class PurchaseOrderDuplicateLineError extends Error {
  constructor() {
    super('PURCHASE_ORDER_DUPLICATE_LINE');
  }
}

export class PurchaseOrderVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('PURCHASE_ORDER_VERSION_CONFLICT');
  }
}

export class PurchaseOrderStateError extends Error {
  constructor(readonly status: string) {
    super('PURCHASE_ORDER_STATE_CONFLICT');
  }
}

export class PurchaseOrderIdempotencyConflictError extends Error {
  constructor() {
    super('PURCHASE_ORDER_IDEMPOTENCY_CONFLICT');
  }
}

export class PurchaseOrderNotFoundError extends Error {
  constructor() {
    super('PURCHASE_ORDER_NOT_FOUND');
  }
}

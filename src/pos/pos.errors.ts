export class PosContextNotFoundError extends Error {
  constructor() {
    super('POS_CONTEXT_NOT_FOUND');
  }
}

export class PosProductNotAvailableError extends Error {
  constructor(readonly productId: string) {
    super('POS_PRODUCT_NOT_AVAILABLE');
  }
}

export class PosInsufficientStockError extends Error {
  constructor(readonly productId: string) {
    super('POS_INSUFFICIENT_STOCK');
  }
}

export class PosIdempotencyConflictError extends Error {
  constructor() {
    super('POS_IDEMPOTENCY_KEY_REUSED');
  }
}

export class SaleAlreadyVoidedError extends Error {
  constructor() {
    super('SALE_ALREADY_VOIDED');
  }
}

export class SaleVoidNotAllowedError extends Error {
  constructor() {
    super('SALE_VOID_NOT_ALLOWED');
  }
}

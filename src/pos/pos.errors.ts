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

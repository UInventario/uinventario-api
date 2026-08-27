export class ProductReservationTargetNotFoundError extends Error {}
export class ProductReservationInsufficientStockError extends Error {
  constructor(readonly productId: string) {
    super('PRODUCT_RESERVATION_INSUFFICIENT_STOCK');
  }
}
export class ProductReservationIdempotencyConflictError extends Error {}

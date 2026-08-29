export class CustomerOrderNotFoundError extends Error {}
export class CustomerOrderStateError extends Error {
  constructor(readonly status: string) {
    super(status);
  }
}
export class CustomerOrderVersionConflictError extends Error {}
export class CustomerOrderIdempotencyConflictError extends Error {}
export class CustomerOrderPriceChangedError extends Error {}
export class CustomerOrderReservationUnavailableError extends Error {}

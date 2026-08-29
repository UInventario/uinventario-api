export class SalesQuotationNotFoundError extends Error {}
export class SalesQuotationIdempotencyConflictError extends Error {}
export class SalesQuotationVersionConflictError extends Error {}
export class SalesQuotationReservationConflictError extends Error {}
export class SalesQuotationStateError extends Error {
  constructor(readonly status: string) {
    super();
  }
}

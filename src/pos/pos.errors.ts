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

export class PosCustomerNotAvailableError extends Error {
  constructor() {
    super('POS_CUSTOMER_NOT_AVAILABLE');
  }
}

export class CustomerCreditNotAvailableError extends Error {
  constructor(readonly reason: 'DISABLED' | 'CURRENCY' | 'INSTALLMENTS') {
    super('CUSTOMER_CREDIT_NOT_AVAILABLE');
  }
}

export class CustomerCreditLimitExceededError extends Error {
  constructor(
    readonly balance: string,
    readonly limit: string,
  ) {
    super('CUSTOMER_CREDIT_LIMIT_EXCEEDED');
  }
}

export class PosReservationNotAvailableError extends Error {
  constructor(readonly status?: string) {
    super('POS_RESERVATION_NOT_AVAILABLE');
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

export class PaymentReferenceConflictError extends Error {
  constructor() {
    super('PAYMENT_REFERENCE_REUSED');
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

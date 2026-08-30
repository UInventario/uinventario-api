export class PaymentTerminalIdempotencyConflictError extends Error {
  constructor() {
    super('PAYMENT_TERMINAL_IDEMPOTENCY_CONFLICT');
  }
}

export class PaymentTerminalOperationError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_CAPTURED'
      | 'ALREADY_USED'
      | 'CONTEXT_MISMATCH'
      | 'AMOUNT_MISMATCH'
      | 'CANNOT_CANCEL',
  ) {
    super(`PAYMENT_TERMINAL_${code}`);
  }
}

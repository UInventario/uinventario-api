export class CashRegisterShiftContextError extends Error {
  constructor() {
    super('CASH_REGISTER_SHIFT_CONTEXT_INVALID');
  }
}

export class CashRegisterShiftConflictError extends Error {
  constructor() {
    super('CASH_REGISTER_SHIFT_CONFLICT');
  }
}

export class CashRegisterShiftIdempotencyConflictError extends Error {
  constructor() {
    super('CASH_REGISTER_SHIFT_IDEMPOTENCY_CONFLICT');
  }
}

export class CashRegisterShiftRequiredError extends Error {
  constructor() {
    super('CASH_REGISTER_SHIFT_REQUIRED');
  }
}

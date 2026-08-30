export class InvalidAccessAssignmentError extends Error {
  constructor() {
    super('INVALID_ACCESS_ASSIGNMENT');
  }
}

export class AccessUserConflictError extends Error {
  constructor() {
    super('ACCESS_USER_CONFLICT');
  }
}

export class AccessUserNotFoundError extends Error {
  constructor() {
    super('ACCESS_USER_NOT_FOUND');
  }
}

export class AccessRetirementConfirmationError extends Error {
  constructor() {
    super('ACCESS_RETIREMENT_CONFIRMATION');
  }
}

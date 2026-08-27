export class OrganizationTargetNotFoundError extends Error {
  constructor() {
    super('ORGANIZATION_TARGET_NOT_FOUND');
  }
}

export class OrganizationNameConflictError extends Error {
  constructor() {
    super('ORGANIZATION_NAME_CONFLICT');
  }
}

export class OrganizationInUseError extends Error {
  constructor() {
    super('ORGANIZATION_IN_USE');
  }
}

export class InitialOrganizationTargetError extends Error {
  constructor() {
    super('INITIAL_ORGANIZATION_TARGET');
  }
}

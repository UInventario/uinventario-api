export class SupplierIdentifierConflictError extends Error {}

export class SupplierVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('SUPPLIER_VERSION_CONFLICT');
  }
}

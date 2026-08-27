export class SupplierIdentifierConflictError extends Error {}

export class SupplierVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('SUPPLIER_VERSION_CONFLICT');
  }
}

export class SupplierProductConflictError extends Error {
  constructor(readonly code: 'RELATION' | 'SUPPLIER_CODE' | 'PRICE_DATE') {
    super(`SUPPLIER_PRODUCT_${code}_CONFLICT`);
  }
}

export class SupplierProductVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('SUPPLIER_PRODUCT_VERSION_CONFLICT');
  }
}

export class SupplierProductReferenceError extends Error {
  constructor(readonly reference: 'SUPPLIER' | 'PRODUCT') {
    super(`SUPPLIER_PRODUCT_${reference}_INVALID`);
  }
}

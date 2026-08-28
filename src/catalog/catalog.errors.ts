export class ProductIdentifierConflictError extends Error {
  constructor(readonly field: 'sku' | 'barcode') {
    super('PRODUCT_IDENTIFIER_CONFLICT');
  }
}

export class ProductVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('PRODUCT_VERSION_CONFLICT');
  }
}

export class CatalogClassificationConflictError extends Error {
  constructor() {
    super('CATALOG_CLASSIFICATION_CONFLICT');
  }
}

export class ProductCodeAmbiguousError extends Error {
  constructor() {
    super('PRODUCT_CODE_AMBIGUOUS');
  }
}

export class ProductLotTrackingLockedError extends Error {
  constructor() {
    super('PRODUCT_LOT_TRACKING_LOCKED');
  }
}

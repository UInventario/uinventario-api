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

export class ProductQuantityPolicyLockedError extends Error {
  constructor() {
    super('PRODUCT_QUANTITY_POLICY_LOCKED');
  }
}

export class ProductSaleBehaviorError extends Error {
  constructor(readonly reason: string) {
    super('PRODUCT_SALE_BEHAVIOR_INVALID');
  }
}

export class ProductVariantConfigurationError extends Error {
  constructor(readonly reason: string) {
    super('PRODUCT_VARIANT_CONFIGURATION_INVALID');
  }
}

export class ProductVariantsRequireZeroStockError extends Error {
  constructor() {
    super('PRODUCT_VARIANTS_REQUIRE_ZERO_STOCK');
  }
}

export class ProductKitConfigurationError extends Error {
  constructor(readonly reason: string) {
    super('PRODUCT_KIT_CONFIGURATION_INVALID');
  }
}

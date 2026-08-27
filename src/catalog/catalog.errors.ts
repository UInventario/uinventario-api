export class ProductIdentifierConflictError extends Error {
  constructor(readonly field: 'sku' | 'barcode') {
    super('PRODUCT_IDENTIFIER_CONFLICT');
  }
}

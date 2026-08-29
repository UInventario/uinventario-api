export interface ProductData {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  baseUnit: import('../common/quantity-policy').ProductBaseUnit;
  quantityPrecision: number;
  quantityRounding: import('../common/quantity-policy').QuantityRoundingMode;
  minimumQuantity: string;
  trackLots: boolean;
  lotExpirationPolicy?: 'NONE' | 'OPTIONAL' | 'REQUIRED';
  lotExpirationAlertDays?: number;
  allowExpiredStockOverride?: boolean;
  trackSerials: boolean;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  cost: string;
  price: string;
  active: boolean;
  version: number;
  parentProductId: string | null;
  variantAttributes: Array<{ name: string; values: string[] }>;
  variantValues: Array<{ attribute: string; value: string }>;
  sellable: boolean;
  variants: ProductData[];
  kit: ProductKitData | null;
}

export interface ProductKitData {
  stockMode: 'DERIVED' | 'ASSEMBLED';
  priceRule: 'FIXED' | 'COMPONENT_SUM';
  effectiveFrom: string | null;
  effectiveTo: string | null;
  components: Array<{
    product: { id: string; name: string; sku: string };
    quantity: string;
  }>;
}

export interface ProductResponse {
  data: ProductData;
  meta: { apiVersion: '1' };
}

export interface ProductRetirementResponse {
  data: {
    outcome: 'DELETED' | 'DEACTIVATED';
    product: ProductData | null;
  };
  meta: { apiVersion: '1' };
}

export interface CatalogOptionsResponse {
  data: {
    categories: Array<{ id: string; name: string }>;
    brands: Array<{ id: string; name: string }>;
  };
  meta: { apiVersion: '1' };
}

export interface CatalogClassificationData {
  id: string;
  name: string;
  active: boolean;
  productCount: number;
}

export interface ProductListResponse {
  data: ProductData[];
  meta: {
    apiVersion: '1';
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
}

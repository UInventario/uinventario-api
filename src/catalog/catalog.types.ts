export interface ProductData {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  cost: string;
  price: string;
  active: boolean;
  version: number;
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

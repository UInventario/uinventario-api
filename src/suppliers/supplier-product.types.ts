export interface SupplierPriceData {
  id: string;
  currency: string;
  unitCost: string;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

export interface SupplierProductData {
  id: string;
  supplier: { id: string; name: string };
  product: {
    id: string;
    name: string;
    sku: string;
    catalogCost: string;
    catalogPrice: string;
  };
  supplierCode: string;
  minimumQuantity: string | null;
  active: boolean;
  version: number;
  prices: SupplierPriceData[];
  createdAt: string;
  updatedAt: string;
}

export interface SupplierProductResponse {
  data: SupplierProductData;
  meta: { apiVersion: '1' };
}

export interface SupplierProductListResponse {
  data: SupplierProductData[];
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

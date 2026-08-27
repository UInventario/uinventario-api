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
}

export interface ProductResponse {
  data: ProductData;
  meta: { apiVersion: '1' };
}

export interface CatalogOptionsResponse {
  data: {
    categories: Array<{ id: string; name: string }>;
    brands: Array<{ id: string; name: string }>;
  };
  meta: { apiVersion: '1' };
}

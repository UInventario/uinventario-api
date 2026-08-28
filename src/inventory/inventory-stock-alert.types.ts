export type InventoryStockAlertStatus = 'LOW' | 'OUT_OF_STOCK' | 'RECOVERED';

export interface InventoryStockAlertData {
  product: { id: string; name: string; sku: string };
  location: { id: string; name: string; code: string };
  status: InventoryStockAlertStatus;
  availableQuantity: string;
  threshold: string;
  transitionedAt: string;
}

export interface InventoryStockAlertListResponse {
  data: InventoryStockAlertData[];
  meta: {
    apiVersion: '1';
    defaultThreshold: string;
    scope: {
      branch: { id: string; name: string };
      warehouse: { id: string; name: string };
    };
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
}

export type InventoryTransferStatus = 'DRAFT' | 'DISPATCHED' | 'CANCELLED';

export interface InventoryTransferLineData {
  id: string;
  lineNumber: number;
  product: { id: string; name: string; sku: string };
  sourceLocation: { id: string; name: string; code: string };
  destinationLocation: { id: string; name: string; code: string };
  quantity: string;
}

export interface InventoryTransferData {
  id: string;
  status: InventoryTransferStatus;
  reference: string;
  reason: string;
  originWarehouse: {
    id: string;
    name: string;
    branch: { id: string; name: string };
  };
  destinationWarehouse: {
    id: string;
    name: string;
    branch: { id: string; name: string };
  };
  lines: InventoryTransferLineData[];
  createdBy: { id: string; email: string };
  dispatchedBy: { id: string; email: string } | null;
  cancelledBy: { id: string; email: string } | null;
  createdAt: string;
  dispatchedAt: string | null;
  cancelledAt: string | null;
}

export interface InventoryTransferResponse {
  data: InventoryTransferData;
  meta: { apiVersion: '1'; idempotentReplay?: boolean };
}

export interface InventoryTransferListResponse {
  data: InventoryTransferData[];
  meta: { apiVersion: '1' };
}

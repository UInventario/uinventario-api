export type InventoryTransferStatus =
  'DRAFT' | 'DISPATCHED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export interface InventoryTransferLineData {
  id: string;
  lineNumber: number;
  product: { id: string; name: string; sku: string };
  sourceLocation: { id: string; name: string; code: string };
  destinationLocation: { id: string; name: string; code: string };
  quantity: string;
  receivedQuantity: string;
  discrepancyQuantity: string;
  pendingQuantity: string;
  serialNumbers: string[];
}

export interface InventoryTransferReceiptLineData {
  id: string;
  lineNumber: number;
  transferLineId: string;
  product: { id: string; name: string; sku: string };
  receivedQuantity: string;
  discrepancyQuantity: string;
}

export interface InventoryTransferReceiptData {
  id: string;
  discrepancyReason: string | null;
  receivedBy: { id: string; email: string };
  createdAt: string;
  lines: InventoryTransferReceiptLineData[];
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
  receipts: InventoryTransferReceiptData[];
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

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'APPROVED'
  | 'SENT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CANCELLED';

export interface PurchaseOrderLineData {
  id: string;
  supplierProductId: string;
  productId: string;
  productName: string;
  productSku: string;
  supplierCode: string;
  quantity: string;
  unitCost: string;
  subtotal: string;
  notes: string | null;
}

export interface PurchaseOrderData {
  id: string;
  folio: string;
  supplier: { id: string; name: string };
  currency: string;
  status: PurchaseOrderStatus;
  notes: string | null;
  subtotal: string;
  total: string;
  version: number;
  approvedAt: string | null;
  sentAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  transitions: PurchaseOrderTransitionData[];
  lines: PurchaseOrderLineData[];
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderTransitionData {
  id: string;
  fromStatus: PurchaseOrderStatus;
  toStatus: PurchaseOrderStatus;
  reason: string | null;
  delivery: { mode: 'SIMULATED'; recipient: string | null } | null;
  createdAt: string;
}

export interface PurchaseOrderResponse {
  data: PurchaseOrderData;
  meta: { apiVersion: '1'; idempotentReplay?: boolean };
}

export interface PurchaseOrderListResponse {
  data: PurchaseOrderData[];
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

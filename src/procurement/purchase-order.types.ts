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
  baseUnit: import('../common/quantity-policy').ProductBaseUnit;
  quantityPrecision: number;
  minimumQuantity: string;
  supplierCode: string;
  quantity: string;
  receivedQuantity: string;
  remainingQuantity: string;
  overageQuantity: string;
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
  receipts: PurchaseReceiptData[];
  returns: PurchaseReturnData[];
  lines: PurchaseOrderLineData[];
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseReceiptData {
  id: string;
  documentReference: string;
  location: { id: string; name: string; code: string };
  responsible: { id: string; email: string };
  overageReason: string | null;
  lines: Array<{
    id: string;
    purchaseOrderLineId: string;
    receivedQuantity: string;
    lotCode: string | null;
    manufacturedOn: string | null;
    expiresOn: string | null;
    overageQuantity: string;
    unitCost: string;
    totalCost: string;
    previousCatalogCost: string;
    resultingCatalogCost: string;
    returnedQuantity: string;
    returnableQuantity: string;
  }>;
  createdAt: string;
}

export interface PurchaseReturnData {
  id: string;
  purchaseReceiptId: string;
  documentReference: string;
  reason: string;
  status: 'CREDIT_PENDING' | 'CREDIT_RECEIVED';
  expectedCreditTotal: string;
  creditDocumentReference: string | null;
  location: { id: string; name: string; code: string };
  responsible: { id: string; email: string };
  lines: Array<{
    id: string;
    purchaseReceiptLineId: string;
    productId: string;
    returnedQuantity: string;
    unitCost: string;
    totalCost: string;
  }>;
  createdAt: string;
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
  meta: {
    apiVersion: '1';
    idempotentReplay?: boolean;
    receiptId?: string;
    returnId?: string;
  };
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

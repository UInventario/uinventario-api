export interface PosProductSnapshot {
  id: string;
  name: string;
  sku: string;
  price: string;
  active: boolean;
  availableQuantity: string;
}

export interface PosCartQuoteResponse {
  data: {
    context: {
      branch: { id: string; name: string };
      warehouse: { id: string; name: string };
      cashRegister: { id: string; name: string; code: string };
    };
    currency: string;
    taxRate: string;
    lines: Array<{
      product: { id: string; name: string; sku: string };
      quantity: string;
      availableQuantity: string;
      unitPrice: string;
      subtotal: string;
      tax: string;
      total: string;
    }>;
    totals: { subtotal: string; tax: string; total: string };
  };
  meta: { apiVersion: '1'; recalculatedAt: string };
}

export interface OfflineCashSaleSnapshot {
  capturedAt: string;
  branchId: string;
  warehouseId: string;
  cashRegisterId: string;
  currency: string;
  taxRate: string;
  paymentMethod: 'CASH';
  negativeStock: 'DENY';
  lines: Array<{
    productId: string;
    name: string;
    sku: string;
    quantity: string;
    unitPrice: string;
    subtotal: string;
    tax: string;
    total: string;
  }>;
  totals: { subtotal: string; tax: string; total: string };
}

export interface CashSaleData {
  id: string;
  receiptNumber: string;
  status: 'COMPLETED' | 'VOIDED';
  context: PosCartQuoteResponse['data']['context'];
  userId: string;
  customer: { id: string; name: string; identifier: string | null } | null;
  currency: string;
  taxRate: string;
  lines: Array<{
    product: { id: string; name: string; sku: string };
    quantity: string;
    unitPrice: string;
    subtotal: string;
    tax: string;
    total: string;
  }>;
  totals: PosCartQuoteResponse['data']['totals'];
  payment: {
    method: 'CASH';
    status: 'COMPLETED' | 'REVERSED';
    amountReceived: string;
    amountApplied: string;
    change: string;
  };
  createdAt: string;
  void: {
    reason: string;
    user: { id: string; email: string };
    voidedAt: string;
  } | null;
}

export interface CashSaleResponse {
  data: CashSaleData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

export interface SaleSummaryData {
  id: string;
  receiptNumber: string;
  status: 'COMPLETED' | 'VOIDED';
  user: { id: string; email: string };
  customer: { id: string; name: string; identifier: string | null } | null;
  cashRegister: { id: string; name: string; code: string };
  currency: string;
  total: string;
  paymentMethod: 'CASH';
  createdAt: string;
}

export interface SaleDetailData extends Omit<CashSaleData, 'userId'> {
  user: { id: string; email: string };
  movements: Array<{
    id: string;
    type: 'SALE' | 'SALE_VOID';
    saleLineId: string;
    product: { id: string; name: string; sku: string };
    location: { id: string; name: string; code: string };
    quantityChange: string;
    resultingQuantity: string;
    reference: string;
    createdAt: string;
  }>;
}

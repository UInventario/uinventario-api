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

export interface CashSaleData {
  id: string;
  receiptNumber: string;
  status: 'COMPLETED';
  context: PosCartQuoteResponse['data']['context'];
  userId: string;
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
    amountReceived: string;
    amountApplied: string;
    change: string;
  };
  createdAt: string;
}

export interface CashSaleResponse {
  data: CashSaleData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

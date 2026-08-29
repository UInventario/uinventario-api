export interface PosProductSnapshot {
  id: string;
  name: string;
  sku: string;
  price: string;
  active: boolean;
  trackLots: boolean;
  trackSerials: boolean;
  availableQuantity: string;
}

export interface PosAppliedDiscount {
  type: 'PERCENT' | 'AMOUNT';
  value: string;
  reason: string;
  amount: string;
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
    discount: PosAppliedDiscount | null;
    lines: Array<{
      product: { id: string; name: string; sku: string };
      quantity: string;
      lotId: string | null;
      serialNumbers: string[];
      availableQuantity: string;
      unitPrice: string;
      priceSource: 'BASE' | 'PRICE_LIST';
      priceList: { id: string; name: string } | null;
      grossTotal: string;
      discount: {
        line: PosAppliedDiscount | null;
        sale: PosAppliedDiscount | null;
        total: string;
      };
      subtotal: string;
      tax: string;
      total: string;
    }>;
    totals: {
      gross: string;
      lineDiscount: string;
      saleDiscount: string;
      discount: string;
      subtotal: string;
      tax: string;
      total: string;
    };
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
  totals: {
    gross?: string;
    lineDiscount?: '0.00';
    saleDiscount?: '0.00';
    discount?: '0.00';
    subtotal: string;
    tax: string;
    total: string;
  };
}

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'VOUCHER' | 'CREDIT';

export interface SalePaymentData {
  id: string;
  method: PaymentMethod;
  status: 'COMPLETED' | 'PENDING' | 'REVERSED';
  amountReceived: string;
  amountApplied: string;
  change: string;
  reference: string | null;
  provider: string;
  authorizationCode: string | null;
}

export interface CashSaleData {
  id: string;
  receiptNumber: string;
  status: 'COMPLETED' | 'VOIDED';
  context: PosCartQuoteResponse['data']['context'];
  userId: string;
  customer: { id: string; name: string; identifier: string | null } | null;
  quotation: { id: string; quotationNumber: string } | null;
  currency: string;
  taxRate: string;
  discount: PosAppliedDiscount | null;
  lines: Array<{
    id: string;
    product: { id: string; name: string; sku: string };
    quantity: string;
    unitPrice: string;
    priceSource: 'BASE' | 'PRICE_LIST';
    priceList: { id: string; name: string } | null;
    grossTotal: string;
    discount: {
      line: PosAppliedDiscount | null;
      sale: PosAppliedDiscount | null;
      total: string;
    };
    subtotal: string;
    tax: string;
    total: string;
    grossProfit: string | null;
  }>;
  totals: PosCartQuoteResponse['data']['totals'] & {
    grossProfit: string | null;
  };
  payment: SalePaymentData;
  payments: SalePaymentData[];
  credit: SaleCreditPlanData | null;
  createdAt: string;
  void: {
    reason: string;
    user: { id: string; email: string };
    voidedAt: string;
  } | null;
}

export interface SaleCreditPlanData {
  accountId: string;
  originalAmount: string;
  balance: string;
  currency: string;
  termDays: number;
  status: 'OPEN' | 'OVERDUE' | 'PAID' | 'CANCELLED';
  dueDate: string;
  installments: Array<{
    number: number;
    dueDate: string;
    amount: string;
  }>;
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
  paymentMethod: PaymentMethod | 'MIXED';
  createdAt: string;
}

export interface SaleDetailData extends Omit<CashSaleData, 'userId'> {
  user: { id: string; email: string };
  movements: Array<{
    id: string;
    type: 'SALE' | 'SALE_VOID' | 'SALE_RETURN';
    saleLineId: string;
    product: { id: string; name: string; sku: string };
    location: { id: string; name: string; code: string };
    quantityChange: string;
    resultingQuantity: string;
    reference: string;
    createdAt: string;
  }>;
}

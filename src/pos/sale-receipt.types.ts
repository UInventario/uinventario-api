import type { PaymentMethod } from './pos.types';

export interface SaleReceiptLine {
  lineNumber: number;
  productName: string;
  productSku: string;
  quantity: string;
  unitPrice: string;
  grossTotal: string;
  discountTotal: string;
  lineDiscountReason: string | null;
  saleDiscountReason: string | null;
  subtotal: string;
  tax: string;
  total: string;
}

export interface SaleReceiptPayment {
  method: PaymentMethod;
  amountReceived: string;
  amountApplied: string;
  change: string;
  reference: string | null;
  provider: string;
  authorizationCode: string | null;
}

export interface SaleReceiptData {
  saleId: string;
  receiptNumber: string;
  documentType: 'NON_FISCAL_SALE_RECEIPT';
  fiscalNotice: 'COMPROBANTE NO FISCAL';
  merchant: {
    name: string;
    legalName: string | null;
    countryCode: string | null;
  };
  branchName: string;
  cashRegister: { name: string; code: string };
  sellerEmail: string;
  customer: { name: string; identifier: string | null } | null;
  currency: string;
  taxRate: string;
  lines: SaleReceiptLine[];
  payments: SaleReceiptPayment[];
  loyalty?: {
    pointsRedeemed: number;
    redemptionValue: string;
    pointsEarned: number;
  } | null;
  totals: {
    gross: string;
    discount: string;
    subtotal: string;
    tax: string;
    total: string;
  };
  issuedAt: string;
  saleStatus: 'COMPLETED' | 'VOIDED';
  void: { reason: string; voidedAt: string } | null;
}

export interface SaleReceiptDeliveryData {
  mode: 'SIMULATED' | 'PROVIDER';
  channel: 'EMAIL';
  recipient: string;
  messageId: string;
  acceptedAt: string;
}

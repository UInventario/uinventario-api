import type { PaymentMethod } from './pos.types';

export interface SaleReceiptLine {
  lineNumber: number;
  productName: string;
  productSku: string;
  quantity: string;
  unitPrice: string;
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
  totals: { subtotal: string; tax: string; total: string };
  issuedAt: string;
  saleStatus: 'COMPLETED' | 'VOIDED';
  void: { reason: string; voidedAt: string } | null;
}

export interface SaleReceiptDeliveryData {
  mode: 'SIMULATED';
  channel: 'EMAIL';
  recipient: string;
  messageId: string;
  acceptedAt: string;
}

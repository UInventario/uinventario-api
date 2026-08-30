export type SaleReturnCondition = 'SELLABLE' | 'DAMAGED';
export type SaleReturnSettlementStatus =
  'PENDING' | 'PARTIALLY_SETTLED' | 'SETTLED';
export type SaleReturnSettlementMode = 'REFUND' | 'STORE_CREDIT';

export interface SaleReturnSettlementData {
  id: string;
  mode: SaleReturnSettlementMode;
  method: 'CASH' | 'CARD' | 'TRANSFER' | 'VOUCHER' | 'STORE_CREDIT';
  status: 'COMPLETED' | 'FAILED';
  currency: string;
  amount: string;
  originalPayment: {
    id: string;
    method: 'CASH' | 'CARD' | 'TRANSFER' | 'VOUCHER';
  } | null;
  provider: string;
  providerReference: string | null;
  failureCode: string | null;
  processedBy: { id: string; email: string };
  createdAt: string;
}

export interface SaleReturnData {
  id: string;
  saleId: string;
  exchangeSale: { id: string; receiptNumber: string } | null;
  reason: string;
  settlementStatus: SaleReturnSettlementStatus;
  refundableAmount: string;
  loyaltyValueRestored: string;
  totals: { subtotal: string; tax: string; total: string };
  returnedBy: { id: string; email: string };
  createdAt: string;
  settlements: SaleReturnSettlementData[];
  lines: Array<{
    id: string;
    saleLineId: string;
    product: { id: string; name: string; sku: string };
    quantity: string;
    condition: SaleReturnCondition;
    totals: { subtotal: string; tax: string; total: string };
    serialNumbers: string[];
  }>;
}

export interface SaleReturnResponse {
  data: SaleReturnData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

export class SaleReturnQuantityError extends Error {}
export class SaleReturnNotAllowedError extends Error {}
export class SaleReturnExchangeError extends Error {}
export class SaleReturnSerialError extends Error {}
export class SaleReturnSettlementAmountError extends Error {}
export class SaleReturnSettlementPaymentError extends Error {}
export class SaleReturnSettlementCustomerError extends Error {}
export class SaleReturnSettlementCashError extends Error {}
export class SaleReturnSettlementShiftError extends Error {}

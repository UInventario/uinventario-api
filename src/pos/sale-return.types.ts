export type SaleReturnCondition = 'SELLABLE' | 'DAMAGED';

export interface SaleReturnData {
  id: string;
  saleId: string;
  exchangeSale: { id: string; receiptNumber: string } | null;
  reason: string;
  settlementStatus: 'PENDING';
  totals: { subtotal: string; tax: string; total: string };
  returnedBy: { id: string; email: string };
  createdAt: string;
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

export interface CustomerData {
  id: string;
  name: string;
  identifier: string | null;
  email: string | null;
  phone: string | null;
  dataProcessingConsent: boolean;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerHistoryPaymentData {
  method: string;
  status: 'COMPLETED' | 'REVERSED';
  amountApplied: string;
  amountReceived: string;
  change: string;
}

export interface CustomerHistoryItemData {
  id: string;
  receiptNumber: string;
  status: 'COMPLETED' | 'VOIDED';
  currency: string;
  total: string;
  createdAt: string;
  cashRegister: { id: string; name: string; code: string };
  responsible: { id: string; email: string };
  payments: CustomerHistoryPaymentData[];
  reversal: { reason: string; voidedAt: string } | null;
}

export interface CustomerHistoryData {
  customer: CustomerData;
  summary: {
    currency: string | null;
    salesCount: number;
    completedCount: number;
    voidedCount: number;
    completedAmount: string;
    voidedAmount: string;
  };
  items: CustomerHistoryItemData[];
}

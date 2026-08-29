export interface CustomerData {
  id: string;
  name: string;
  identifier: string | null;
  email: string | null;
  phone: string | null;
  dataProcessingConsent: boolean;
  privacyStatus: 'ACTIVE' | 'ANONYMIZED';
  anonymizedAt: string | null;
  privacyRetentionUntil: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  credit: CustomerCreditData | null;
}

export interface CustomerCreditData {
  enabled: boolean;
  limit: string;
  currency: string;
  termDays: number;
  maxInstallments: number;
  balance: string;
  available: string;
  overdueAmount: string;
  status: 'DISABLED' | 'AVAILABLE' | 'LIMIT_REACHED' | 'OVERDUE';
}

export interface CustomerHistoryPaymentData {
  method: string;
  status: 'COMPLETED' | 'PENDING' | 'REVERSED';
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

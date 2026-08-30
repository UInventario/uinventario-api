export const ACCOUNTING_SOURCE_TYPES = [
  'SALE',
  'SALE_VOID',
  'SALE_RETURN',
  'CASH_MOVEMENT',
] as const;
export type AccountingSourceType = (typeof ACCOUNTING_SOURCE_TYPES)[number];

export type AccountingEventStatus =
  'PENDING' | 'EXPORTED' | 'REJECTED' | 'INDETERMINATE';

export interface AccountingEntry {
  accountReference: string;
  debit: string;
  credit: string;
  memo: string;
}

export interface AccountingEventData {
  id: string;
  eventKey: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  provider: 'SIMULATOR';
  contractVersion: '1';
  currency: string;
  occurredAt: string;
  reference: string;
  journalStatus: 'CANDIDATE_NOT_POSTED';
  entries: AccountingEntry[];
  debitTotal: string;
  creditTotal: string;
  status: AccountingEventStatus;
  attemptCount: number;
  errorCode: string | null;
  providerReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountingSourceCandidate {
  event_key: string;
  source_type: AccountingSourceType;
  source_id: string;
  occurred_at: Date | string;
  currency: string;
  reference_key: string;
  subtotal: string;
  tax_total: string;
  total: string;
  cost_total: string;
  cash_type: 'INCOME' | 'WITHDRAWAL' | 'REVERSAL' | null;
  reversed_cash_type: 'INCOME' | 'WITHDRAWAL' | null;
}

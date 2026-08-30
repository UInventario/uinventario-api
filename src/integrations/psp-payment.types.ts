export const PSP_SCENARIOS = ['SUCCESS', 'DECLINE', 'TIMEOUT'] as const;
export type PspScenario = (typeof PSP_SCENARIOS)[number];

export const PSP_PAYMENT_STATUSES = [
  'REQUIRES_CONFIRMATION',
  'AUTHORIZED',
  'CAPTURED',
  'INDETERMINATE',
  'DECLINED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;
export type PspPaymentStatus = (typeof PSP_PAYMENT_STATUSES)[number];

export type PspAction = 'CONFIRM' | 'CAPTURE' | 'QUERY' | 'REFUND';

export interface PspPaymentData {
  id: string;
  provider: 'SIMULATOR';
  adapterVersion: '1';
  providerReference: string;
  merchantReference: string;
  amount: string;
  refundedAmount: string;
  currency: string;
  status: PspPaymentStatus;
  scenario: PspScenario;
  errorCode: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PspAdapterState {
  status: PspPaymentStatus;
  errorCode: string | null;
}

export interface PspWebhookResult {
  payment: PspPaymentData;
  replay: boolean;
  ignoredOutOfOrder: boolean;
}

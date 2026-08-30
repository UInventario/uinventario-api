export const PAYMENT_TERMINAL_SCENARIOS = [
  'SUCCESS',
  'REJECT',
  'INDETERMINATE',
] as const;

export type PaymentTerminalScenario =
  (typeof PAYMENT_TERMINAL_SCENARIOS)[number];

export type PaymentTerminalStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'DECLINED'
  | 'INDETERMINATE'
  | 'CANCELLED';

export interface PaymentTerminalOperationData {
  id: string;
  provider: string;
  adapterVersion: string;
  providerReference: string | null;
  amount: string;
  currency: string;
  status: PaymentTerminalStatus;
  errorCode: string | null;
  authorizationCode: string | null;
  correlationId: string;
  saleId: string | null;
  queryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentTerminalAdapterState {
  providerReference: string;
  status: PaymentTerminalStatus;
  authorizationCode: string | null;
  errorCode: string | null;
}

export const EXTERNAL_ADAPTER_CAPABILITIES = [
  'NOTIFICATION_EMAIL',
  'NOTIFICATION_PUSH',
] as const;

export type ExternalAdapterCapability =
  (typeof EXTERNAL_ADAPTER_CAPABILITIES)[number];
export type ExternalAdapterStatus =
  'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'RETRYABLE_FAILURE' | 'TIMED_OUT';
export type ExternalAdapterScenario =
  'SUCCESS' | 'REJECT' | 'TIMEOUT' | 'RETRY';

export interface ExternalAdapterConfigData {
  id: string;
  capability: ExternalAdapterCapability;
  countryCode: string;
  provider: string;
  adapterVersion: string;
  enabled: boolean;
  timeoutMs: number;
  maxAttempts: number;
  secretReference: string | null;
  updatedAt: string;
}

export interface ExternalAdapterExecutionData {
  id: string;
  capability: ExternalAdapterCapability;
  provider: string;
  adapterVersion: string;
  idempotencyKey: string;
  correlationId: string;
  status: ExternalAdapterStatus;
  attemptCount: number;
  errorCode: string | null;
  providerReference: string | null;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAdapterCommand {
  apiVersion: '1';
  tenantId: string;
  capability: ExternalAdapterCapability;
  idempotencyKey: string;
  correlationId: string;
  attempt: number;
  scenario?: ExternalAdapterScenario;
  payload: { recipient: string; title: string; body: string };
}

export type ExternalAdapterResult =
  | { status: 'SUCCEEDED'; providerReference: string }
  | {
      status: 'REJECTED' | 'RETRYABLE_FAILURE';
      errorCode: string;
    };

export interface VersionedExternalAdapter {
  readonly capability: ExternalAdapterCapability;
  readonly provider: string;
  readonly version: string;
  execute(
    command: ExternalAdapterCommand,
    signal: AbortSignal,
  ): Promise<ExternalAdapterResult>;
}

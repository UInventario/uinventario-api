export const EXTERNAL_ADAPTER_CAPABILITIES = [
  'NOTIFICATION_EMAIL',
  'NOTIFICATION_PUSH',
  'NOTIFICATION_WHATSAPP',
] as const;

export type ExternalAdapterCapability =
  (typeof EXTERNAL_ADAPTER_CAPABILITIES)[number];
export type ExternalAdapterStatus =
  'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'RETRYABLE_FAILURE' | 'TIMED_OUT';
export type ExternalAdapterScenario =
  'SUCCESS' | 'REJECT' | 'TIMEOUT' | 'RETRY';
export type ExternalEmailTemplateKey =
  | 'ADAPTER_DIAGNOSTIC'
  | 'PASSWORD_RESET'
  | 'SALE_RECEIPT'
  | 'OPERATIONAL_NOTIFICATION'
  | 'WHATSAPP_SALE_RECEIPT'
  | 'WHATSAPP_ORDER_STATUS'
  | 'WHATSAPP_OPERATIONAL_NOTICE';

export interface ExternalEmailTemplate {
  key: ExternalEmailTemplateKey;
  version: '1';
}

export type ExternalEmailEventType =
  | 'SENT'
  | 'DELIVERED'
  | 'DELIVERY_DELAYED'
  | 'BOUNCED'
  | 'FAILED'
  | 'SUPPRESSED'
  | 'COMPLAINED';

export interface ExternalEmailEventData {
  webhookEventId: string;
  provider: string;
  providerReference: string;
  eventType: ExternalEmailEventType;
  errorCode: string | null;
  occurredAt: string;
  receivedAt: string;
}

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
  secretReference: string | null;
  scenario?: ExternalAdapterScenario;
  payload: {
    recipient: string;
    title: string;
    body: string;
    template: ExternalEmailTemplate;
  };
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

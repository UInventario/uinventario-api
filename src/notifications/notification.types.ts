export const NOTIFICATION_EVENT_TYPES = [
  'STOCK_LOW',
  'LOT_EXPIRING',
  'PURCHASE_PENDING',
  'CASH_DIFFERENCE',
  'SYNC_FAILED',
  'OPERATION_FAILED',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationFrequency = 'IMMEDIATE' | 'DAILY_DIGEST';
export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type NotificationDeliveryChannel = 'EMAIL' | 'PUSH';
export type NotificationDeliveryStatus =
  'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface NotificationSourceEvent {
  eventType: NotificationEventType;
  sourceKey: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  branchId: string | null;
  occurredAt: string;
}

export interface NotificationPreferenceData {
  id: string;
  recipient: { id: string; email: string };
  eventType: NotificationEventType;
  enabled: boolean;
  channels: { inApp: boolean; email: boolean; push: boolean };
  frequency: NotificationFrequency;
  updatedAt: string;
}

export interface NotificationData {
  id: string;
  eventType: NotificationEventType;
  title: string;
  body: string;
  severity: NotificationSeverity;
  digestCount: number;
  sourceOccurredAt: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationDeliveryData {
  id: string;
  notificationId: string;
  recipient: { id: string; email: string };
  eventType: NotificationEventType;
  title: string;
  channel: NotificationDeliveryChannel;
  adapter: string;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  errorCode: string | null;
  deliveredAt: string | null;
}

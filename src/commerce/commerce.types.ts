export const COMMERCE_SCOPES = [
  'CATALOG_READ',
  'STOCK_READ',
  'ORDERS_WRITE',
  'ORDERS_READ',
] as const;

export type CommerceScope = (typeof COMMERCE_SCOPES)[number];

export const COMMERCE_WEBHOOK_EVENTS = [
  'ORDER_CONFIRMED',
  'ORDER_PREPARING',
  'ORDER_READY',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'ORDER_FULFILLMENT_UPDATED',
] as const;

export type CommerceWebhookEvent = (typeof COMMERCE_WEBHOOK_EVENTS)[number];

export interface CommerceCredentialData {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: CommerceScope[];
  context: {
    branch: { id: string; name: string };
    warehouse: { id: string; name: string };
    cashRegister: { id: string; name: string; code: string };
    location: { id: string; name: string; code: string };
    customer: { id: string; name: string };
  };
  active: boolean;
  rateLimitPerMinute: number;
  webhook: {
    url: string | null;
    events: CommerceWebhookEvent[];
    enabled: boolean;
    mode: 'SIMULATOR';
  };
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommercePrincipal {
  credentialId: string;
  tenantId: string;
  actorUserId: string;
  scopes: CommerceScope[];
  keyHash: string;
  rateLimitPerMinute: number;
  context: {
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    locationId: string;
    customerId: string;
  };
}

export interface CommerceWebhookDeliveryData {
  id: string;
  eventId: string;
  eventType: CommerceWebhookEvent;
  targetUrl: string;
  signature: string;
  status: 'PENDING' | 'SUCCEEDED' | 'RETRYABLE_FAILURE' | 'FAILED';
  attemptCount: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

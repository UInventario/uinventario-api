import type { PaymentMethod } from '../pos/dto/create-sale.dto';
import type { PriceChannel } from '../pricing/price-list.types';

export type CustomerOrderPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type CustomerOrderStatus =
  'DRAFT' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELLED';
export type CustomerOrderFulfillmentStatus =
  | 'PENDING'
  | 'PREPARING'
  | 'READY'
  | 'RETRYABLE_FAILURE'
  | 'DISPATCHED'
  | 'DELIVERED'
  | 'CANCELLED';

export interface CustomerOrderData {
  id: string;
  orderNumber: string;
  channel: PriceChannel;
  priority: CustomerOrderPriority;
  status: CustomerOrderStatus;
  version: number;
  customer: { id: string; name: string; identifier: string | null };
  context: {
    branch: { id: string; name: string };
    warehouse: { id: string; name: string };
    cashRegister: { id: string; name: string; code: string };
    location: { id: string; name: string; code: string };
  };
  currency: string;
  totals: { subtotal: string; tax: string; total: string };
  expiresInHours: number;
  fulfillment: {
    method: 'PICKUP' | 'DELIVERY';
    status: CustomerOrderFulfillmentStatus;
    deliveryCost: string;
    window: { start: string; end: string };
    address: {
      recipientNameMasked: string;
      phoneMasked: string;
      summary: string;
      countryCode: string;
    } | null;
    carrier: {
      code: 'SIMULATED' | 'SIMULATED_RETRY';
      name: string;
      providerVersion: '1';
      trackingReference: string | null;
      label: { format: 'ZPL'; payload: string } | null;
      trackingStatus:
        | 'LABEL_READY'
        | 'IN_TRANSIT'
        | 'OUT_FOR_DELIVERY'
        | 'DELIVERED'
        | 'EXCEPTION'
        | 'CANCELLED'
        | null;
      latestEventSequence: number;
      latestEventAt: string | null;
      manualActionRequired: boolean;
      attempts: number;
      lastErrorCode: string | null;
      lastAttemptAt: string | null;
    } | null;
    responsible: {
      preparation: { id: string; email: string } | null;
      delivery: { id: string; email: string } | null;
    };
  };
  reservation: { id: string; reservationNumber: string; status: string } | null;
  sale: { id: string; receiptNumber: string } | null;
  lines: Array<{
    id: string;
    product: { id: string; name: string; sku: string };
    quantity: string;
    lotId: string | null;
    serialNumbers: string[];
    unitPrice: string;
    grossTotal: string;
    discountTotal: string;
    subtotal: string;
    tax: string;
    total: string;
  }>;
  payments: Array<{
    id: string;
    method: PaymentMethod;
    amount: string;
    amountReceived: string;
    reference: string | null;
    status: 'PLANNED' | 'COMPLETED' | 'CANCELLED';
  }>;
  transitions: Array<{
    id: string;
    fromStatus: CustomerOrderStatus;
    toStatus: CustomerOrderStatus;
    reason: string | null;
    actor: { id: string; email: string };
    createdAt: string;
  }>;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerOrderResponse {
  data: CustomerOrderData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

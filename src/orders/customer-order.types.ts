import type { PaymentMethod } from '../pos/dto/create-sale.dto';
import type { PriceChannel } from '../pricing/price-list.types';

export type CustomerOrderPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type CustomerOrderStatus =
  'DRAFT' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELLED';

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

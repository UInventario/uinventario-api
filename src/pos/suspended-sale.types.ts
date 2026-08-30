import type { PosCartQuoteResponse } from './pos.types';

export type SuspendedSaleStatus =
  'ACTIVE' | 'CANCELLED' | 'RESUMED' | 'EXPIRED';

export interface SuspendedSaleData {
  id: string;
  status: SuspendedSaleStatus;
  context: PosCartQuoteResponse['data']['context'];
  author: { id: string; email: string };
  customer: { id: string; name: string; identifier: string | null } | null;
  notes: string | null;
  lines: Array<{
    product: { id: string; name: string; sku: string };
    quantity: string;
    lotId: string | null;
    serialNumbers: string[];
    unitPriceSnapshot: string;
    availableQuantitySnapshot: string;
  }>;
  completedSaleId: string | null;
  expiresAt: string;
  createdAt: string;
  cancelledAt: string | null;
  resumedAt: string | null;
}

export interface SuspendedSaleConflict {
  code:
    | 'PRICE_CHANGED'
    | 'AVAILABILITY_CHANGED'
    | 'INSUFFICIENT_STOCK'
    | 'PRODUCT_NOT_AVAILABLE';
  productId: string;
  previous?: string;
  current?: string;
}

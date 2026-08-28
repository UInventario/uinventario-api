export interface ProductReservationData {
  id: string;
  reservationNumber: string;
  status: 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'CONSUMED';
  customer: { id: string; name: string; identifier: string | null };
  context: {
    branch: { id: string; name: string };
    warehouse: { id: string; name: string };
    location: { id: string; name: string; code: string };
  };
  responsible: { id: string; email: string };
  expiresAt: string;
  createdAt: string;
  closedAt: string | null;
  closureReason: string | null;
  sale: { id: string; receiptNumber: string } | null;
  lines: Array<{
    id: string;
    product: { id: string; name: string; sku: string };
    quantity: string;
    serialNumbers: string[];
  }>;
}

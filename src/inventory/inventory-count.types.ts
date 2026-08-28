export type InventoryCountSessionStatus = 'OPEN' | 'CLOSED';

export interface InventoryCountAttemptData {
  attempt: number;
  countedQuantity: string;
  responsible: { id: string; email: string };
  createdAt: string;
}

export interface InventoryCountSessionLineData {
  product: { id: string; name: string; sku: string };
  snapshotQuantity: string | null;
  countedQuantity: string | null;
  varianceQuantity: string | null;
  attemptCount: number;
  countedBy: { id: string; email: string } | null;
  countedAt: string | null;
  movementId: string | null;
  attempts: InventoryCountAttemptData[];
}

export interface InventoryCountSessionData {
  id: string;
  status: InventoryCountSessionStatus;
  blind: boolean;
  branch: { id: string; name: string };
  warehouse: { id: string; name: string };
  location: { id: string; name: string; code: string };
  createdBy: { id: string; email: string };
  closedBy: { id: string; email: string } | null;
  createdAt: string;
  closedAt: string | null;
  lines: InventoryCountSessionLineData[];
}

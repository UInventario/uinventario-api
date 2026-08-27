export type InventoryMovementType = 'INITIAL' | 'ENTRY' | 'ADJUSTMENT';

export interface InventoryLocationData {
  id: string;
  name: string;
  code: string;
}

export interface InventoryBalanceData {
  product: { id: string; name: string; sku: string };
  location: InventoryLocationData;
  quantity: string;
}

export interface InventoryMovementData extends InventoryBalanceData {
  id: string;
  type: InventoryMovementType;
  quantityChange: string;
  reason: string;
  reference: string | null;
  createdAt: string;
}

export interface InventoryLocationsResponse {
  data: InventoryLocationData[];
  meta: { apiVersion: '1' };
}

export interface InventoryBalanceResponse {
  data: InventoryBalanceData;
  meta: { apiVersion: '1' };
}

export interface InventoryMovementResponse {
  data: InventoryMovementData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

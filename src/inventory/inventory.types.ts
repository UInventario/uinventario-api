export const INVENTORY_MOVEMENT_TYPES = [
  'INITIAL',
  'ENTRY',
  'EXIT',
  'RETURN',
  'LOSS',
  'DAMAGE',
  'ADJUSTMENT',
  'IMPORT',
  'STATE_TRANSITION',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'TRANSFER_RECEIPT',
  'TRANSFER_DISCREPANCY',
  'SALE',
  'SALE_VOID',
  'PURCHASE_RECEIPT',
  'SUPPLIER_RETURN',
] as const;

export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];
export type UserInventoryMovementType = Exclude<
  InventoryMovementType,
  | 'STATE_TRANSITION'
  | 'IMPORT'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'TRANSFER_RECEIPT'
  | 'TRANSFER_DISCREPANCY'
  | 'SALE'
  | 'SALE_VOID'
  | 'PURCHASE_RECEIPT'
  | 'SUPPLIER_RETURN'
>;
export type InventoryStockState =
  'AVAILABLE' | 'RESERVED' | 'DAMAGED' | 'IN_TRANSIT';

export const INVENTORY_STOCK_POLICY = {
  negativeStock: 'DENY',
} as const;

export type InventoryStockPolicy = typeof INVENTORY_STOCK_POLICY;

export interface InventoryStateQuantity {
  code: InventoryStockState;
  quantity: string;
}

export interface InventoryLocationData {
  id: string;
  name: string;
  code: string;
}

export interface InventoryBalanceData {
  product: { id: string; name: string; sku: string };
  location: InventoryLocationData;
  quantity: string;
  availableQuantity?: string;
  totalQuantity?: string;
  states?: InventoryStateQuantity[];
}

export interface InventoryMovementData extends InventoryBalanceData {
  id: string;
  type: InventoryMovementType;
  quantityChange: string;
  reason: string;
  reference: string | null;
  createdAt: string;
  stateTransition: {
    from: InventoryStockState;
    to: InventoryStockState;
    quantity: string;
  } | null;
}

export interface InventoryLocationsResponse {
  data: InventoryLocationData[];
  meta: { apiVersion: '1' };
}

export interface InventoryBalanceResponse {
  data: InventoryBalanceData;
  meta: { apiVersion: '1'; policy: InventoryStockPolicy };
}

export interface InventoryMovementResponse {
  data: InventoryMovementData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

export interface InventoryMovementHistoryItem {
  id: string;
  type: InventoryMovementType;
  direction: 'IN' | 'OUT' | 'TRANSFER';
  quantityChange: string;
  previousQuantity: string;
  resultingQuantity: string;
  reason: string;
  reference: string | null;
  createdAt: string;
  product: { id: string; name: string; sku: string };
  location: {
    id: string;
    name: string;
    code: string;
    warehouse: { id: string; name: string };
  };
  responsible: { id: string; email: string };
  correlationId: string;
  idempotencyKey: string;
  document: {
    type:
      | 'MOVEMENT'
      | 'IMPORT'
      | 'SALE'
      | 'TRANSFER'
      | 'RECEIPT'
      | 'PURCHASE_RECEIPT'
      | 'SUPPLIER_RETURN'
      | 'RESERVATION';
    id: string;
    reference: string | null;
  };
  stateTransition: {
    from: InventoryStockState;
    to: InventoryStockState;
    quantity: string;
  } | null;
}

export interface InventoryMovementListResponse {
  data: InventoryMovementHistoryItem[];
  meta: {
    apiVersion: '1';
    scope: { branch: { id: string; name: string } };
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
}

export interface InventoryStockItem {
  product: { id: string; name: string; sku: string; active: boolean };
  availableQuantity: string;
  totalQuantity: string;
  states: InventoryStateQuantity[];
}

export interface InventoryStateTransitionResponse {
  data: InventoryMovementData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

export interface InventoryStockListResponse {
  data: InventoryStockItem[];
  meta: {
    apiVersion: '1';
    policy: InventoryStockPolicy;
    scope: {
      branch: { id: string; name: string };
      warehouse: { id: string; name: string };
    };
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
}

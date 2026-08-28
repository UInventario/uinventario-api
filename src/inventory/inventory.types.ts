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
  valuation: InventoryMovementValuation | null;
  fifoValuation: InventoryFifoMovementValuation | null;
  fifoLayers?: InventoryFifoAllocation[];
}

export interface InventoryMovementValuation {
  unitCost: string;
  valueChange: string;
  resultingInventoryValue: string | null;
  averageUnitCost: string | null;
}

export interface InventoryFifoMovementValuation {
  unitCost: string;
  valueChange: string;
  resultingInventoryValue: string;
}

export interface InventoryFifoAllocation {
  allocationId: string;
  layerId: string;
  sourceAllocationId: string | null;
  quantityChange: string;
  unitCost: string;
  currency: string;
  valueChange: string;
  selectionMode: 'ENTRY' | 'FIFO' | 'RESTORE' | 'TRANSFER' | 'ORIGIN_RETURN';
}

export interface InventoryLotAllocation {
  id: string;
  code: string;
  quantityChange: string;
  unitCost: string;
  currency: string;
  valueChange: string;
  selectionMode: 'ORIGIN' | 'MANUAL' | 'AUTOMATIC' | 'RESTORE' | 'TRANSFER';
}

export interface InventoryLotData {
  id: string;
  code: string;
  product: { id: string; name: string; sku: string };
  quantity: string;
  unitCost: string;
  currency: string;
  inventoryValue: string;
  createdAt: string;
  origins: Array<{
    purchaseReceiptLineId: string;
    quantity: string;
    unitCost: string;
    currency: string;
    receipt: { id: string; documentReference: string };
    purchaseOrder: { id: string; folio: string };
  }>;
  balances: Array<{
    location: InventoryLocationData;
    quantity: string;
  }>;
}

export interface InventoryLotsResponse {
  data: InventoryLotData[];
  meta: {
    apiVersion: '1';
    tracked: boolean;
    totalQuantity: string;
    lotQuantity: string;
    reconciled: boolean;
    currency: string | null;
    inventoryValue: string;
  };
}

export interface InventoryFifoLayerData {
  id: string;
  product: { id: string; name: string; sku: string };
  location: InventoryLocationData;
  originType:
    'MIGRATION_CUT' | 'ENTRY' | 'PURCHASE_RECEIPT' | 'RETURN' | 'TRANSFER';
  originalQuantity: string;
  remainingQuantity: string;
  unitCost: string;
  currency: string;
  inventoryValue: string;
  acquiredAt: string;
  source: {
    movementId: string | null;
    movementType: InventoryMovementType | null;
    reference: string | null;
    layerId: string | null;
    purchaseReceiptLineId: string | null;
  };
}

export interface InventoryFifoLayersResponse {
  data: InventoryFifoLayerData[];
  meta: {
    apiVersion: '1';
    method: 'FIFO';
    cutover: {
      effectiveAt: string;
      migrationRule: 'OPENING_BALANCE_AT_MOVING_AVERAGE';
    };
    totalQuantity: string;
    layerQuantity: string;
    reconciled: boolean;
    currency: string | null;
    inventoryValue: string;
  };
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

export interface InventoryCountData {
  id: string;
  product: { id: string; name: string; sku: string };
  location: InventoryLocationData;
  snapshotQuantity: string;
  countedQuantity: string;
  varianceQuantity: string;
  reason: string;
  reference: string;
  capturedAt: string;
  createdAt: string;
  movementId: string | null;
}

export interface InventoryCountInput {
  productId: string;
  locationId: string;
  snapshotQuantity: string;
  countedQuantity: string;
  reason: string;
  reference: string;
  capturedAt: string;
}

export interface InventoryCountResponse {
  data: InventoryCountData;
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
  valuation: InventoryMovementValuation | null;
  lots: InventoryLotAllocation[];
  fifoValuation: InventoryFifoMovementValuation | null;
  fifoLayers: InventoryFifoAllocation[];
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
  product: {
    id: string;
    name: string;
    sku: string;
    active: boolean;
    trackLots: boolean;
  };
  availableQuantity: string;
  totalQuantity: string;
  states: InventoryStateQuantity[];
  averageUnitCost: string;
  inventoryValue: string;
  valuation: {
    quantity: string;
    inventoryValue: string;
    quantityReconciled: boolean;
    valueReconciled: boolean;
    reconciled: boolean;
  };
  lotTracking: {
    lotQuantity: string;
    reconciled: boolean;
    currency: string | null;
    inventoryValue: string;
  } | null;
  fifoValuation: {
    quantity: string;
    inventoryValue: string;
    currency: string | null;
    reconciled: boolean;
  };
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

export const INVENTORY_VALUATION_METHODS = [
  'MOVING_AVERAGE',
  'FIFO',
  'SPECIFIC_LOT',
] as const;

export type InventoryValuationMethod =
  (typeof INVENTORY_VALUATION_METHODS)[number];

export interface InventoryValuationPolicyData {
  method: InventoryValuationMethod;
  version: number;
  effectiveAt: string;
  migrationRule: 'INITIAL_DEFAULT' | 'FORWARD_ONLY_CUTOVER';
}

export interface InventoryValuationMigrationPlan {
  current: InventoryValuationPolicyData;
  targetMethod: InventoryValuationMethod;
  allowed: boolean;
  blockingReasons: string[];
  strategy:
    | 'USE_MAINTAINED_MOVING_AVERAGE'
    | 'USE_MAINTAINED_FIFO_LAYERS'
    | 'OPENING_LOTS_AT_MOVING_AVERAGE';
  productsToMigrate: number;
  locationsToMigrate: number;
  devicesToRebootstrap: number;
  planFingerprint: string;
}

export type InventoryReconciliationSeverity = 'WARNING' | 'CRITICAL';
export type InventoryReconciliationStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';

export interface InventoryReconciliationFindingData {
  id: string;
  code: string;
  severity: InventoryReconciliationSeverity;
  scopeType: 'TENANT' | 'PRODUCT' | 'LOCATION' | 'LOT' | 'SERIAL' | 'VALUATION';
  product: { id: string; name: string; sku: string } | null;
  location: { id: string; name: string; code: string } | null;
  subjectReference: string | null;
  expectedValue: string | null;
  actualValue: string | null;
  differenceValue: string | null;
  message: string;
  recommendedAction: string;
  blocksOperations: boolean;
}

export interface InventoryReconciliationRunData {
  id: string;
  status: 'RUNNING' | 'COMPLETED';
  overallStatus: InventoryReconciliationStatus;
  summary: {
    findings: number;
    warnings: number;
    critical: number;
  };
  policy: { releaseBlocked: boolean; operationsBlocked: boolean };
  correlationId: string;
  responsible: { id: string; email: string };
  startedAt: string;
  finishedAt: string | null;
  findings: InventoryReconciliationFindingData[];
}

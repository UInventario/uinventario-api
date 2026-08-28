import type { AppPermission } from '../auth/authorization/authorization.types';
import type { InventoryValuationPolicyData } from '../inventory/inventory-valuation-policy.types';

export const OFFLINE_SYNC_PROTOCOL_VERSION = '1.0' as const;
export const OFFLINE_SYNC_MAX_PAGE_SIZE = 500 as const;

export const OFFLINE_SYNC_COMPATIBILITY_POLICY_V1 = {
  apiVersion: 'v1',
  currentProtocolVersion: OFFLINE_SYNC_PROTOCOL_VERSION,
  minimumProtocolVersion: '1.0',
  supportedMajorVersion: 1,
  deprecationNoticeDays: 180,
  breakingChangesRequireNewMajor: true,
} as const;

export const OFFLINE_FRESHNESS_POLICY_V1 = {
  version: 1,
  maxClockSkewSeconds: 300,
  catalogTtlSeconds: 86_400,
  permissionsTtlSeconds: 3_600,
  actionTtlSeconds: {
    CASH_SALE: 900,
    INVENTORY_COUNT: 14_400,
    INVENTORY_MOVEMENT: 3_600,
  },
} as const;

export type OfflineFreshnessPolicyV1 = typeof OFFLINE_FRESHNESS_POLICY_V1;

export const OFFLINE_SYNC_ENTITY_KINDS = [
  'BRANCH',
  'WAREHOUSE',
  'LOCATION',
  'CASH_REGISTER',
  'CATEGORY',
  'BRAND',
  'PRODUCT',
  'INVENTORY_AVAILABILITY',
] as const;

export type OfflineSyncEntityKind = (typeof OFFLINE_SYNC_ENTITY_KINDS)[number];

export interface OfflineSyncScopeV1 {
  tenantId: string;
  userId: string;
  deviceId: string;
  branchId: string | null;
  cashRegisterId: string | null;
}

export interface OfflineSyncRecordV1 {
  id: string;
  tenantId: string;
  version: number;
  updatedAt: string;
}

export interface OfflineBranchV1 extends OfflineSyncRecordV1 {
  kind: 'BRANCH';
  name: string;
  timezone: string;
  active: boolean;
}

export interface OfflineWarehouseV1 extends OfflineSyncRecordV1 {
  kind: 'WAREHOUSE';
  branchId: string;
  name: string;
  active: boolean;
}

export interface OfflineLocationV1 extends OfflineSyncRecordV1 {
  kind: 'LOCATION';
  warehouseId: string;
  code: string;
  name: string;
  active: boolean;
}

export interface OfflineCashRegisterV1 extends OfflineSyncRecordV1 {
  kind: 'CASH_REGISTER';
  branchId: string;
  code: string;
  name: string;
  active: boolean;
}

export interface OfflineClassificationV1 extends OfflineSyncRecordV1 {
  kind: 'CATEGORY' | 'BRAND';
  name: string;
  active: boolean;
}

export interface OfflineProductV1 extends OfflineSyncRecordV1 {
  kind: 'PRODUCT';
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: string | null;
  brandId: string | null;
  price: string;
  active: boolean;
}

export interface OfflineInventoryAvailabilityV1 extends OfflineSyncRecordV1 {
  kind: 'INVENTORY_AVAILABILITY';
  productId: string;
  locationId: string;
  availableQuantity: string;
}

export interface OfflinePosPolicyV1 extends OfflineSyncRecordV1 {
  kind: 'POS_POLICY';
  branchId: string;
  warehouseId: string;
  cashRegisterId: string;
  shiftId: string;
  shiftOpenedAt: string;
  currency: string;
  taxRate: string;
  paymentMethods: ['CASH'];
  negativeStock: 'DENY';
}

export type OfflineSyncEntityV1 =
  | OfflineBranchV1
  | OfflineWarehouseV1
  | OfflineLocationV1
  | OfflineCashRegisterV1
  | OfflineClassificationV1
  | OfflineProductV1
  | OfflineInventoryAvailabilityV1;

export interface OfflineBootstrapRequestV1 {
  protocolVersion: typeof OFFLINE_SYNC_PROTOCOL_VERSION;
  deviceId: string;
  cursor?: string;
  pageSize: number;
}

export interface OfflineBootstrapResponseV1 {
  protocolVersion: typeof OFFLINE_SYNC_PROTOCOL_VERSION;
  generatedAt: string;
  sessionExpiresAt: string;
  freshnessPolicy: OfflineFreshnessPolicyV1;
  scope: OfflineSyncScopeV1;
  identity: {
    tenant: { id: string; name: string };
    user: { id: string; roles: string[]; permissions: AppPermission[] };
  };
  valuationPolicy: InventoryValuationPolicyData;
  posPolicy: OfflinePosPolicyV1 | null;
  page: {
    initialSyncCursor: string;
    cursor: string;
    nextCursor: string | null;
    complete: boolean;
    entities: OfflineSyncEntityV1[];
  };
}

export interface OfflineChangeV1 {
  changeId: string;
  operation: 'UPSERT' | 'DELETE';
  occurredAt: string;
  entity: OfflineSyncEntityV1;
}

export interface OfflineChangesResponseV1 {
  protocolVersion: typeof OFFLINE_SYNC_PROTOCOL_VERSION;
  generatedAt: string;
  sessionExpiresAt: string;
  freshnessPolicy: OfflineFreshnessPolicyV1;
  scope: OfflineSyncScopeV1;
  identity: {
    user: { id: string; roles: string[]; permissions: AppPermission[] };
  };
  cursor: string;
  nextCursor: string;
  hasMore: boolean;
  changes: OfflineChangeV1[];
}

export interface OfflineCommandV1 {
  protocolVersion: typeof OFFLINE_SYNC_PROTOCOL_VERSION;
  commandId: string;
  idempotencyKey: string;
  scope: OfflineSyncScopeV1;
  sequence: number;
  createdAt: string;
  valuationMethod: InventoryValuationPolicyData['method'];
  valuationPolicyVersion: number;
  kind: 'CASH_SALE' | 'INVENTORY_COUNT' | 'INVENTORY_MOVEMENT';
  payload: Readonly<Record<string, unknown>>;
}

export const OFFLINE_SYNC_FORBIDDEN_FIELDS = [
  'password',
  'passwordHash',
  'sessionToken',
  'refreshToken',
  'resetToken',
  'apiKey',
  'privateKey',
] as const;

export function supportsOfflineSyncVersion(version: string): boolean {
  return /^1\.\d+$/.test(version);
}

export function assertOfflineSyncPageSize(pageSize: number): void {
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > OFFLINE_SYNC_MAX_PAGE_SIZE
  )
    throw new RangeError(
      `pageSize must be between 1 and ${OFFLINE_SYNC_MAX_PAGE_SIZE}`,
    );
}

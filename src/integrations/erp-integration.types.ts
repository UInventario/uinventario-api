export const ERP_RESOURCES = [
  'PRODUCT',
  'SUPPLIER',
  'CUSTOMER',
  'PURCHASE_ORDER',
  'PURCHASE_RECEIPT',
  'SALE',
] as const;

export type ErpResource = (typeof ERP_RESOURCES)[number];

export interface ErpExportRow {
  id: string;
  external_id: string | null;
  changed_at: Date | string;
  changed_cursor: string;
  payload: string | Record<string, unknown>;
}

export interface ErpMappingResult {
  index: number;
  resource: ErpResource;
  externalId: string;
  internalId: string;
  status: 'LINKED' | 'ERROR';
  replay: boolean;
  errorCode: 'INTERNAL_RECORD_NOT_FOUND' | 'MAPPING_CONFLICT' | null;
}

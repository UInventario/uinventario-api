import type { InventoryImportMode } from './dto/preview-inventory-import.dto';
import type { InventoryStockState } from './inventory.types';

export interface InventoryImportFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface InventoryImportRowError {
  code: string;
  message: string;
}

export interface InventoryImportPreviewRow {
  id: string;
  rowNumber: number;
  product: { id: string; name: string; sku: string } | null;
  location: { id: string; name: string; code: string } | null;
  state: InventoryStockState | null;
  targetQuantity: string | null;
  currentQuantity: string | null;
  difference: string | null;
  reason: string;
  errors: InventoryImportRowError[];
}

export interface InventoryImportResponse {
  data: {
    id: string;
    mode: InventoryImportMode;
    status: 'PREVIEWED' | 'CONFIRMED';
    sourceFilename: string;
    policy: 'ATOMIC';
    canConfirm: boolean;
    summary: {
      rows: number;
      validRows: number;
      errorRows: number;
      movements: number | null;
    };
    rows: InventoryImportPreviewRow[];
    confirmedAt: string | null;
  };
  meta: { apiVersion: '1'; idempotentReplay?: boolean };
}

import type { FiscalDocumentType } from '../integrations/fiscal-contract.types';
import type {
  FiscalDocumentStatus,
  FiscalSimulatorScenario,
} from '../integrations/fiscal-provider-adapter.types';

export type SaleFiscalWorkflowStatus = FiscalDocumentStatus | 'SENT';

export interface SaleFiscalDocumentData {
  id: string;
  saleId: string;
  receiptNumber: string;
  category: 'FISCAL_DOCUMENT';
  documentType: FiscalDocumentType;
  provider: 'SIMULATOR';
  providerVersion: '1';
  providerReference: string | null;
  scenario: FiscalSimulatorScenario;
  status: FiscalDocumentStatus;
  errorCode: string | null;
  artifacts: Array<{
    kind: 'PDF' | 'XML';
    path: string;
  }>;
  events: Array<{ status: SaleFiscalWorkflowStatus; occurredAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface SaleFiscalDocumentInternal extends SaleFiscalDocumentData {
  simulatorDocumentId: string | null;
  providerIdempotencyKey: string;
  requestFingerprint: string;
}

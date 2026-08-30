import type {
  FiscalDocumentStatus,
  FiscalSimulatorScenario,
} from './fiscal-provider-adapter.types';
import type { FiscalDocumentType } from './fiscal-contract.types';

export interface FiscalSimulatorDocumentData {
  id: string;
  countryCode: string;
  contractVersion: string;
  documentType: FiscalDocumentType;
  reference: string;
  provider: 'SIMULATOR';
  providerVersion: '1';
  providerReference: string;
  scenario: FiscalSimulatorScenario;
  status: FiscalDocumentStatus;
  pollCount: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

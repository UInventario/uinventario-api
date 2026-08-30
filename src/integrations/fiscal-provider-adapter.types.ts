import type { FiscalDocumentType } from './fiscal-contract.types';

export type FiscalDocumentStatus =
  'PENDING' | 'ACCEPTED' | 'REJECTED' | 'INDETERMINATE' | 'CANCELLED';
export type FiscalSimulatorScenario = 'SUCCESS' | 'REJECT' | 'TIMEOUT';
export type FiscalArtifactKind = 'PDF' | 'XML';

export interface FiscalAdapterDocument {
  providerReference: string;
  status: FiscalDocumentStatus;
  errorCode: string | null;
  artifacts?: Partial<Record<FiscalArtifactKind, string>>;
}

export interface VersionedFiscalProviderAdapter {
  readonly provider: string;
  readonly version: string;
  issue(input: {
    countryCode: string;
    documentType: FiscalDocumentType;
    reference: string;
    scenario: FiscalSimulatorScenario;
  }): Promise<FiscalAdapterDocument>;
  query(input: {
    providerReference: string;
    countryCode: string;
    documentType: FiscalDocumentType;
    scenario: FiscalSimulatorScenario;
    pollCount: number;
    currentStatus: FiscalDocumentStatus;
  }): Promise<FiscalAdapterDocument>;
  cancel(input: {
    providerReference: string;
    currentStatus: FiscalDocumentStatus;
  }): Promise<FiscalAdapterDocument>;
  download(input: {
    providerReference: string;
    status: FiscalDocumentStatus;
    kind: FiscalArtifactKind;
    contentBase64: string | null;
  }): Promise<{ mediaType: string; fileName: string; contentBase64: string }>;
}

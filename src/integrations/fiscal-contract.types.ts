export const FISCAL_DOCUMENT_TYPES = [
  'INVOICE',
  'RECEIPT',
  'CREDIT_NOTE',
  'PAYMENT_RECEIPT',
] as const;
export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number];

export const FISCAL_CAPABILITIES = [
  'ISSUE',
  'QUERY',
  'CANCEL',
  'DOWNLOAD_PDF',
  'DOWNLOAD_XML',
  'ASYNC_CALLBACK',
] as const;
export type FiscalCapability = (typeof FISCAL_CAPABILITIES)[number];
export type FiscalProviderProfile = 'SIMULATOR' | 'LIVE_GENERIC';
export type FiscalFolioMode = 'PROVIDER' | 'LOCAL_AUTHORIZED';

export interface FiscalCountryContract {
  countryCode: 'MX' | 'CL';
  version: '1';
  authority: 'SAT' | 'SII';
  currency: 'MXN' | 'CLP';
  documentTypes: Array<{
    type: FiscalDocumentType;
    countryCode: string;
    label: string;
  }>;
  taxes: Array<{ code: string; label: string; rate: number | null }>;
  folioModes: FiscalFolioMode[];
  capabilities: FiscalCapability[];
  providerProfiles: Array<{
    key: FiscalProviderProfile;
    mode: 'SIMULATOR' | 'LIVE';
    runtimeAvailable: false;
    requirements: FiscalRequirement[];
  }>;
}

export type FiscalRequirement =
  | 'TAX_IDENTIFIER'
  | 'CERTIFICATE_SECRET_REFERENCE'
  | 'PRIVATE_KEY_SECRET_REFERENCE'
  | 'FOLIO_AUTHORIZATION_SECRET_REFERENCE'
  | 'ENVIRONMENT';

export interface FiscalTenantConfiguration {
  id: string | null;
  countryCode: string;
  contractVersion: '1';
  providerProfile: FiscalProviderProfile;
  enabled: boolean;
  documentTypes: FiscalDocumentType[];
  taxCodes: string[];
  folioMode: FiscalFolioMode;
  taxIdentifier: string | null;
  certificateSecretReference: string | null;
  privateKeySecretReference: string | null;
  folioAuthorizationSecretReference: string | null;
  environment: 'TEST' | 'PRODUCTION' | null;
  updatedAt: string | null;
}

export interface FiscalContractValidation {
  valid: boolean;
  readyForAdapter: boolean;
  missingRequirements: FiscalRequirement[];
  incompatibleSelections: string[];
  runtime: 'NOT_IMPLEMENTED';
}

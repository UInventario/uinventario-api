import { Injectable } from '@nestjs/common';
import type {
  FiscalContractValidation,
  FiscalCountryContract,
  FiscalRequirement,
  FiscalTenantConfiguration,
} from './fiscal-contract.types';

const CONTRACTS: FiscalCountryContract[] = [
  {
    countryCode: 'MX',
    version: '1',
    authority: 'SAT',
    currency: 'MXN',
    documentTypes: [
      { type: 'INVOICE', countryCode: 'I', label: 'Comprobante de ingreso' },
      { type: 'CREDIT_NOTE', countryCode: 'E', label: 'Comprobante de egreso' },
      {
        type: 'PAYMENT_RECEIPT',
        countryCode: 'P',
        label: 'Complemento de pago',
      },
    ],
    taxes: [
      { code: 'VAT_16', label: 'IVA 16%', rate: 0.16 },
      { code: 'VAT_8', label: 'IVA 8%', rate: 0.08 },
      { code: 'VAT_0', label: 'IVA 0%', rate: 0 },
      { code: 'EXEMPT', label: 'Exento', rate: null },
    ],
    folioModes: ['PROVIDER'],
    capabilities: [
      'ISSUE',
      'QUERY',
      'CANCEL',
      'DOWNLOAD_PDF',
      'DOWNLOAD_XML',
      'ASYNC_CALLBACK',
    ],
    providerProfiles: [
      {
        key: 'SIMULATOR',
        mode: 'SIMULATOR',
        runtimeAvailable: false,
        requirements: [],
      },
      {
        key: 'LIVE_GENERIC',
        mode: 'LIVE',
        runtimeAvailable: false,
        requirements: [
          'TAX_IDENTIFIER',
          'CERTIFICATE_SECRET_REFERENCE',
          'PRIVATE_KEY_SECRET_REFERENCE',
          'ENVIRONMENT',
        ],
      },
    ],
  },
  {
    countryCode: 'CL',
    version: '1',
    authority: 'SII',
    currency: 'CLP',
    documentTypes: [
      { type: 'INVOICE', countryCode: '33', label: 'Factura electrónica' },
      { type: 'RECEIPT', countryCode: '39', label: 'Boleta electrónica' },
      {
        type: 'CREDIT_NOTE',
        countryCode: '61',
        label: 'Nota de crédito electrónica',
      },
    ],
    taxes: [
      { code: 'VAT_19', label: 'IVA 19%', rate: 0.19 },
      { code: 'EXEMPT', label: 'Exento', rate: null },
    ],
    folioModes: ['LOCAL_AUTHORIZED'],
    capabilities: [
      'ISSUE',
      'QUERY',
      'CANCEL',
      'DOWNLOAD_PDF',
      'DOWNLOAD_XML',
      'ASYNC_CALLBACK',
    ],
    providerProfiles: [
      {
        key: 'SIMULATOR',
        mode: 'SIMULATOR',
        runtimeAvailable: false,
        requirements: [],
      },
      {
        key: 'LIVE_GENERIC',
        mode: 'LIVE',
        runtimeAvailable: false,
        requirements: [
          'TAX_IDENTIFIER',
          'CERTIFICATE_SECRET_REFERENCE',
          'FOLIO_AUTHORIZATION_SECRET_REFERENCE',
          'ENVIRONMENT',
        ],
      },
    ],
  },
];

@Injectable()
export class FiscalContractRegistry {
  get(countryCode: string, version = '1'): FiscalCountryContract | null {
    return (
      CONTRACTS.find(
        (contract) =>
          contract.countryCode === countryCode && contract.version === version,
      ) ?? null
    );
  }

  catalog(): FiscalCountryContract[] {
    return CONTRACTS;
  }

  draft(contract: FiscalCountryContract): FiscalTenantConfiguration {
    return {
      id: null,
      countryCode: contract.countryCode,
      contractVersion: contract.version,
      providerProfile: 'SIMULATOR',
      enabled: false,
      documentTypes: [contract.documentTypes[0].type],
      taxCodes: [contract.taxes[0].code],
      folioMode: contract.folioModes[0],
      taxIdentifier: null,
      certificateSecretReference: null,
      privateKeySecretReference: null,
      folioAuthorizationSecretReference: null,
      environment: 'TEST',
      updatedAt: null,
    };
  }

  validate(
    contract: FiscalCountryContract,
    configuration: FiscalTenantConfiguration,
  ): FiscalContractValidation {
    const incompatibilities: string[] = [];
    const provider = contract.providerProfiles.find(
      ({ key }) => key === configuration.providerProfile,
    );
    if (!provider) incompatibilities.push('PROVIDER_PROFILE_NOT_SUPPORTED');
    if (configuration.countryCode !== contract.countryCode) {
      incompatibilities.push('COUNTRY_DOES_NOT_MATCH_TENANT');
    }
    if (configuration.contractVersion !== contract.version) {
      incompatibilities.push('CONTRACT_VERSION_NOT_SUPPORTED');
    }
    const documentTypes = new Set(
      contract.documentTypes.map(({ type }) => type),
    );
    if (
      configuration.documentTypes.length === 0 ||
      configuration.documentTypes.some((type) => !documentTypes.has(type))
    ) {
      incompatibilities.push('DOCUMENT_TYPES_NOT_SUPPORTED');
    }
    const taxCodes = new Set(contract.taxes.map(({ code }) => code));
    if (
      configuration.taxCodes.length === 0 ||
      configuration.taxCodes.some((code) => !taxCodes.has(code))
    ) {
      incompatibilities.push('TAX_CODES_NOT_SUPPORTED');
    }
    if (!contract.folioModes.includes(configuration.folioMode)) {
      incompatibilities.push('FOLIO_MODE_NOT_SUPPORTED');
    }
    const missing = (provider?.requirements ?? []).filter(
      (requirement) => !this.hasRequirement(requirement, configuration),
    );
    const valid = incompatibilities.length === 0 && missing.length === 0;
    return {
      valid,
      readyForAdapter: valid,
      missingRequirements: missing,
      incompatibleSelections: incompatibilities,
      runtime: 'NOT_IMPLEMENTED',
    };
  }

  private hasRequirement(
    requirement: FiscalRequirement,
    config: FiscalTenantConfiguration,
  ): boolean {
    const fields: Record<FiscalRequirement, string | null> = {
      TAX_IDENTIFIER: config.taxIdentifier,
      CERTIFICATE_SECRET_REFERENCE: config.certificateSecretReference,
      PRIVATE_KEY_SECRET_REFERENCE: config.privateKeySecretReference,
      FOLIO_AUTHORIZATION_SECRET_REFERENCE:
        config.folioAuthorizationSecretReference,
      ENVIRONMENT: config.environment,
    };
    return Boolean(fields[requirement]);
  }
}

import { FiscalContractRegistry } from './fiscal-contract.registry';

describe('FiscalContractRegistry', () => {
  const registry = new FiscalContractRegistry();

  it('exposes independent versioned fixtures for Mexico and Chile', () => {
    const mexico = registry.get('MX');
    const chile = registry.get('CL');

    expect(mexico).toMatchObject({
      version: '1',
      authority: 'SAT',
      currency: 'MXN',
      folioModes: ['PROVIDER'],
    });
    expect(mexico?.documentTypes.map(({ type }) => type)).toContain(
      'PAYMENT_RECEIPT',
    );
    expect(mexico?.taxes.map(({ code }) => code)).toContain('VAT_16');
    expect(chile).toMatchObject({
      version: '1',
      authority: 'SII',
      currency: 'CLP',
      folioModes: ['LOCAL_AUTHORIZED'],
    });
    expect(chile?.documentTypes.map(({ type }) => type)).toContain('RECEIPT');
    expect(chile?.taxes.map(({ code }) => code)).toContain('VAT_19');
  });

  it('reports provider and country requirements without accepting secret values', () => {
    const chile = registry.get('CL')!;
    const draft = {
      ...registry.draft(chile),
      providerProfile: 'LIVE_GENERIC' as const,
      enabled: false,
    };
    const incomplete = registry.validate(chile, draft);

    expect(incomplete.valid).toBe(false);
    expect(incomplete.missingRequirements).toEqual([
      'TAX_IDENTIFIER',
      'CERTIFICATE_SECRET_REFERENCE',
      'FOLIO_AUTHORIZATION_SECRET_REFERENCE',
    ]);

    const complete = registry.validate(chile, {
      ...draft,
      taxIdentifier: '76000000-0',
      certificateSecretReference: 'cl-certificate-secret',
      folioAuthorizationSecretReference: 'cl-folio-secret',
      environment: 'TEST',
    });
    expect(complete).toMatchObject({
      valid: true,
      readyForAdapter: true,
      missingRequirements: [],
      runtime: 'NOT_IMPLEMENTED',
    });
  });

  it('rejects selections from another country contract', () => {
    const mexico = registry.get('MX')!;
    const invalid = registry.validate(mexico, {
      ...registry.draft(mexico),
      countryCode: 'CL',
      documentTypes: ['RECEIPT'],
      taxCodes: ['VAT_19'],
      folioMode: 'LOCAL_AUTHORIZED',
    });

    expect(invalid.incompatibleSelections).toEqual([
      'COUNTRY_DOES_NOT_MATCH_TENANT',
      'DOCUMENT_TYPES_NOT_SUPPORTED',
      'TAX_CODES_NOT_SUPPORTED',
      'FOLIO_MODE_NOT_SUPPORTED',
    ]);
  });
});

import type { DataSource } from 'typeorm';
import { FiscalContractRepository } from './fiscal-contract.repository';

describe('FiscalContractRepository', () => {
  it('reads and writes configuration only through the requested tenant scope', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([
        {
          id: 'config-1',
          country_code: 'MX',
          contract_version: '1',
          provider_profile: 'SIMULATOR',
          enabled: false,
          document_types: '["INVOICE"]',
          tax_codes: '["VAT_16"]',
          folio_mode: 'PROVIDER',
          tax_identifier: null,
          certificate_secret_reference: null,
          private_key_secret_reference: null,
          folio_authorization_secret_reference: null,
          environment: 'TEST',
          updated_at: '2026-08-29T12:00:00.000Z',
        },
      ]);
    const repository = new FiscalContractRepository({
      query,
    } as unknown as DataSource);

    const configuration = await repository.save('tenant-1', 'MX', {
      contractVersion: '1',
      providerProfile: 'SIMULATOR',
      enabled: false,
      documentTypes: ['INVOICE'],
      taxCodes: ['VAT_16'],
      folioMode: 'PROVIDER',
      environment: 'TEST',
    });

    expect(configuration).toMatchObject({
      countryCode: 'MX',
      documentTypes: ['INVOICE'],
      taxCodes: ['VAT_16'],
    });
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[0][1]).toContain('tenant-1');
    expect(String(calls[1][0])).toContain('WHERE tenant_id = ?');
    expect(calls[1][1]).toEqual(['tenant-1']);
  });
});

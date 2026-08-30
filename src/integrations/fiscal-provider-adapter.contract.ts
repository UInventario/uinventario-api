import type { VersionedFiscalProviderAdapter } from './fiscal-provider-adapter.types';

export function fiscalProviderAdapterContract(
  createAdapter: () => VersionedFiscalProviderAdapter,
): void {
  describe('FiscalProviderAdapter contract v1', () => {
    let adapter: VersionedFiscalProviderAdapter;

    beforeEach(() => {
      adapter = createAdapter();
    });

    it('issues and downloads accepted documents', async () => {
      const issued = await adapter.issue({
        countryCode: 'MX',
        documentType: 'INVOICE',
        reference: 'contract-success',
        scenario: 'SUCCESS',
      });
      expect(issued).toMatchObject({ status: 'ACCEPTED', errorCode: null });
      expect(issued.artifacts?.PDF).toBeTruthy();
      expect(issued.artifacts?.XML).toBeTruthy();
      const pdf = await adapter.download({
        providerReference: issued.providerReference,
        status: issued.status,
        kind: 'PDF',
        contentBase64: issued.artifacts!.PDF!,
      });
      expect(pdf).toMatchObject({ mediaType: 'application/pdf' });
      expect(Buffer.from(pdf.contentBase64, 'base64').toString()).toContain(
        '%PDF-1.4',
      );
    });

    it('returns a sanitized rejection', async () => {
      await expect(
        adapter.issue({
          countryCode: 'CL',
          documentType: 'RECEIPT',
          reference: 'contract-reject',
          scenario: 'REJECT',
        }),
      ).resolves.toMatchObject({
        status: 'REJECTED',
        errorCode: 'SIMULATED_REJECTION',
      });
    });

    it('keeps timeout indeterminate until requery resolves it', async () => {
      const issued = await adapter.issue({
        countryCode: 'MX',
        documentType: 'INVOICE',
        reference: 'contract-timeout',
        scenario: 'TIMEOUT',
      });
      expect(issued.status).toBe('INDETERMINATE');
      const first = await adapter.query({
        providerReference: issued.providerReference,
        countryCode: 'MX',
        documentType: 'INVOICE',
        scenario: 'TIMEOUT',
        pollCount: 1,
        currentStatus: issued.status,
      });
      expect(first.status).toBe('INDETERMINATE');
      const second = await adapter.query({
        providerReference: issued.providerReference,
        countryCode: 'MX',
        documentType: 'INVOICE',
        scenario: 'TIMEOUT',
        pollCount: 2,
        currentStatus: first.status,
      });
      expect(second.status).toBe('ACCEPTED');
      expect(second.artifacts?.XML).toBeTruthy();
    });

    it('cancels accepted documents without changing provider identity', async () => {
      const issued = await adapter.issue({
        countryCode: 'CL',
        documentType: 'INVOICE',
        reference: 'contract-cancel',
        scenario: 'SUCCESS',
      });
      const cancelled = await adapter.cancel({
        providerReference: issued.providerReference,
        currentStatus: issued.status,
      });
      expect(cancelled).toEqual({
        providerReference: issued.providerReference,
        status: 'CANCELLED',
        errorCode: null,
      });
    });
  });
}

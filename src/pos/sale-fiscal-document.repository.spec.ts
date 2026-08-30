import type { DataSource, EntityManager } from 'typeorm';
import { SaleFiscalDocumentRepository } from './sale-fiscal-document.repository';

describe('SaleFiscalDocumentRepository', () => {
  const row = {
    id: 'fiscal-1',
    sale_id: 'sale-1',
    receipt_number: 'V-ABC123',
    document_type: 'INVOICE',
    scenario: 'SUCCESS',
    status: 'PENDING',
    simulator_document_id: null,
    provider_reference: null,
    error_code: null,
    provider_idempotency_key: 'provider-key',
    request_fingerprint: 'fingerprint',
    created_at: '2026-08-29T12:00:00.000Z',
    updated_at: '2026-08-29T12:00:00.000Z',
  };

  it('creates PENDING and its event in one tenant-scoped transaction', async () => {
    const transactionManager = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ affectedRows: 1 })
        .mockResolvedValueOnce({ affectedRows: 1 }),
    } as unknown as EntityManager;
    const eventManager = {
      query: jest
        .fn()
        .mockResolvedValue([
          { status: 'PENDING', occurred_at: '2026-08-29T12:00:00.000Z' },
        ]),
    } as unknown as EntityManager;
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row]);
    const dataSource = {
      query,
      manager: eventManager,
      transaction: jest.fn((work: (manager: EntityManager) => unknown) =>
        work(transactionManager),
      ),
    } as unknown as DataSource;
    const repository = new SaleFiscalDocumentRepository(dataSource);

    const created = await repository.start({
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
      receiptNumber: 'V-ABC123',
      documentType: 'INVOICE',
      scenario: 'SUCCESS',
      providerIdempotencyKey: 'provider-key',
      fingerprint: 'fingerprint',
    });

    expect(created.replay).toBe(false);
    const transactionCalls = (transactionManager.query as jest.Mock).mock
      .calls as unknown as Array<[string, unknown[]]>;
    expect(transactionCalls).toHaveLength(2);
    expect(transactionCalls[0][1]).toContain('tenant-1');
    expect(transactionCalls[1][0]).toContain('sale_fiscal_document_events');
    expect(created.document.events).toHaveLength(1);
  });

  it('rejects a different request for a sale that already has a document', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([row]),
      manager: {
        query: jest
          .fn()
          .mockResolvedValue([
            { status: 'PENDING', occurred_at: '2026-08-29T12:00:00.000Z' },
          ]),
      },
    } as unknown as DataSource;
    const repository = new SaleFiscalDocumentRepository(dataSource);

    await expect(
      repository.start({
        tenantId: 'tenant-1',
        branchId: 'branch-1',
        saleId: 'sale-1',
        receiptNumber: 'V-ABC123',
        documentType: 'RECEIPT',
        scenario: 'REJECT',
        providerIdempotencyKey: 'other-key',
        fingerprint: 'different-fingerprint',
      }),
    ).rejects.toThrow('FISCAL_DOCUMENT_IDEMPOTENCY_CONFLICT');
  });
});

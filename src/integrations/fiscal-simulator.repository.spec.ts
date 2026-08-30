import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { FiscalSimulatorRepository } from './fiscal-simulator.repository';
import { SimulatedFiscalAdapter } from './simulated-fiscal.adapter';

describe('FiscalSimulatorRepository', () => {
  const dto = {
    documentType: 'INVOICE' as const,
    reference: 'safe-reference',
    scenario: 'SUCCESS' as const,
  };

  const documentRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'document-1',
    country_code: 'MX',
    contract_version: '1',
    document_type: 'INVOICE',
    reference_key: 'safe-reference',
    provider_reference: 'SIM-REFERENCE',
    scenario: 'SUCCESS',
    status: 'ACCEPTED',
    poll_count: 0,
    error_code: null,
    pdf_base64: 'cGRm',
    xml_base64: 'eG1s',
    request_fingerprint: createHash('sha256')
      .update(JSON.stringify(dto))
      .digest('hex'),
    created_at: '2026-08-29T12:00:00.000Z',
    updated_at: '2026-08-29T12:00:00.000Z',
    ...overrides,
  });

  it('persists a sanitized issue in tenant scope', async () => {
    const row = documentRow();
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([row]);
    const adapter = new SimulatedFiscalAdapter();
    const repository = new FiscalSimulatorRepository(
      { query } as unknown as DataSource,
      adapter,
    );

    const created = await repository.issue({
      tenantId: 'tenant-1',
      countryCode: 'MX',
      contractVersion: '1',
      idempotencyKey: 'fiscal-issue-1',
      dto,
    });

    expect(created.replay).toBe(false);
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[1][1]).toContain('tenant-1');
    expect(JSON.stringify(calls[1][1])).not.toContain('customer');
    expect(String(calls[2][0])).toContain('tenant_id = ?');
  });

  it('replays an issue without calling the provider again', async () => {
    const query = jest.fn().mockResolvedValueOnce([documentRow()]);
    const adapter = new SimulatedFiscalAdapter();
    const issue = jest.spyOn(adapter, 'issue');
    const repository = new FiscalSimulatorRepository(
      { query } as unknown as DataSource,
      adapter,
    );

    const replayed = await repository.issue({
      tenantId: 'tenant-1',
      countryCode: 'MX',
      contractVersion: '1',
      idempotencyKey: 'fiscal-issue-1',
      dto,
    });

    expect(replayed.replay).toBe(true);
    expect(issue).not.toHaveBeenCalled();
  });

  it('deduplicates an identical callback without updating the document', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ affectedRows: 0 })
        .mockResolvedValueOnce([
          { document_id: 'document-1', status: 'ACCEPTED' },
        ])
        .mockResolvedValueOnce([documentRow()])
        .mockResolvedValueOnce([documentRow()]),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn((work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource;
    const repository = new FiscalSimulatorRepository(
      dataSource,
      new SimulatedFiscalAdapter(),
    );

    const replayed = await repository.callback({
      tenantId: 'tenant-1',
      eventId: 'event-1',
      documentId: 'document-1',
      status: 'ACCEPTED',
    });

    expect(replayed.replay).toBe(true);
    expect((manager.query as jest.Mock).mock.calls).toHaveLength(4);
    expect(
      (manager.query as jest.Mock).mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE fiscal_simulator_documents'),
      ),
    ).toBe(false);
  });

  it('rejects a late callback instead of resurrecting a cancelled document', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ affectedRows: 1 })
        .mockResolvedValueOnce([documentRow({ status: 'CANCELLED' })]),
    } as unknown as EntityManager;
    const repository = new FiscalSimulatorRepository(
      {
        transaction: jest.fn((work: (value: EntityManager) => unknown) =>
          work(manager),
        ),
      } as unknown as DataSource,
      new SimulatedFiscalAdapter(),
    );

    await expect(
      repository.callback({
        tenantId: 'tenant-1',
        eventId: 'event-late',
        documentId: 'document-1',
        status: 'ACCEPTED',
      }),
    ).rejects.toThrow('FISCAL_DOCUMENT_ALREADY_CANCELLED');
  });

  it('rechecks an operation after locking and replays a concurrent retry', async () => {
    const result = {
      id: 'document-1',
      countryCode: 'MX',
      contractVersion: '1',
      documentType: 'INVOICE',
      reference: 'safe-reference',
      provider: 'SIMULATOR',
      providerVersion: '1',
      providerReference: 'SIM-REFERENCE',
      scenario: 'SUCCESS',
      status: 'ACCEPTED',
      pollCount: 0,
      errorCode: null,
      createdAt: '2026-08-29T12:00:00.000Z',
      updatedAt: '2026-08-29T12:00:00.000Z',
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ documentId: 'document-1', action: 'QUERY' }))
      .digest('hex');
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([documentRow()])
        .mockResolvedValueOnce([{ fingerprint, result }]),
    } as unknown as EntityManager;
    const adapter = new SimulatedFiscalAdapter();
    const queryProvider = jest.spyOn(adapter, 'query');
    const repository = new FiscalSimulatorRepository(
      {
        transaction: jest.fn((work: (value: EntityManager) => unknown) =>
          work(manager),
        ),
      } as unknown as DataSource,
      adapter,
    );

    const replayed = await repository.query({
      tenantId: 'tenant-1',
      documentId: 'document-1',
      idempotencyKey: 'operation-query-1',
    });

    expect(replayed).toEqual({ document: result, replay: true });
    expect(queryProvider).not.toHaveBeenCalled();
  });
});

import type { DataSource, EntityManager } from 'typeorm';
import { ErpIntegrationRepository } from './erp-integration.repository';

describe('ErpIntegrationRepository', () => {
  it('preserves order, links valid records and reports partial errors', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ affectedRows: 1 })
        .mockResolvedValueOnce([{ id: 'internal-1' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ affectedRows: 1 })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'internal-3' }])
        .mockResolvedValueOnce([
          { external_id: 'ERP-3', internal_id: 'internal-3' },
        ])
        .mockResolvedValueOnce({ affectedRows: 1 }),
    } as unknown as EntityManager;
    const repository = new ErpIntegrationRepository({
      transaction: jest.fn((work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource);

    const result = await repository.importMappings({
      tenantId: 'tenant-1',
      provider: 'SIMULATOR',
      idempotencyKey: 'erp-import-001',
      fingerprint: 'fingerprint',
      records: [
        { resource: 'PRODUCT', externalId: 'ERP-1', internalId: 'internal-1' },
        { resource: 'SUPPLIER', externalId: 'ERP-2', internalId: 'missing-2' },
        { resource: 'CUSTOMER', externalId: 'ERP-3', internalId: 'internal-3' },
      ],
    });

    expect(result.replay).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({ index: 0, status: 'LINKED', replay: false }),
      expect.objectContaining({
        index: 1,
        status: 'ERROR',
        errorCode: 'INTERNAL_RECORD_NOT_FOUND',
      }),
      expect.objectContaining({ index: 2, status: 'LINKED', replay: true }),
    ]);
    const calls = (manager.query as jest.Mock).mock.calls as unknown as Array<
      [string, unknown[]]
    >;
    expect(calls.at(-1)?.[1]?.[0]).toContain('"index":0');
  });

  it('replays an identical completed batch without processing records again', async () => {
    const stored = [
      {
        index: 0,
        resource: 'SALE',
        externalId: 'ERP-SALE-1',
        internalId: 'sale-1',
        status: 'LINKED',
        replay: false,
        errorCode: null,
      },
    ];
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ affectedRows: 0 })
        .mockResolvedValueOnce([
          {
            id: 'run-1',
            provider: 'SIMULATOR',
            request_fingerprint: 'fingerprint',
            status: 'COMPLETED',
            result: JSON.stringify(stored),
            created_at: '2026-08-29T12:00:00.000Z',
            updated_at: '2026-08-29T12:00:00.000Z',
          },
        ]),
    } as unknown as EntityManager;
    const repository = new ErpIntegrationRepository({
      transaction: jest.fn((work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource);

    const result = await repository.importMappings({
      tenantId: 'tenant-1',
      provider: 'SIMULATOR',
      idempotencyKey: 'erp-import-001',
      fingerprint: 'fingerprint',
      records: [
        {
          resource: 'SALE',
          externalId: 'ERP-SALE-1',
          internalId: 'sale-1',
        },
      ],
    });

    expect(result).toEqual({ runId: 'run-1', results: stored, replay: true });
    expect((manager.query as jest.Mock).mock.calls).toHaveLength(3);
  });
});

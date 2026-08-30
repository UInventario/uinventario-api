import type { AuditService } from '../audit/audit.service';
import type { ErpIntegrationRepository } from './erp-integration.repository';
import { ErpIntegrationService } from './erp-integration.service';
import { ERP_RESOURCES } from './erp-integration.types';

describe('ErpIntegrationService', () => {
  it('publishes a versioned contract for every required resource', () => {
    const service = new ErpIntegrationService(
      {} as ErpIntegrationRepository,
      {} as AuditService,
    );

    const result = service.contract();

    expect(result.data.version).toBe('1');
    expect(result.data.mode).toBe('SIMULATOR');
    expect(result.data.resources.map(({ resource }) => resource)).toEqual(
      ERP_RESOURCES,
    );
    expect(result.data.guarantees.circularWritesPrevented).toBe(true);
  });

  it('exports an ordered page with an opaque continuation cursor', async () => {
    const repository = {
      exportRows: jest.fn().mockResolvedValue([
        {
          id: '11111111-1111-4111-8111-111111111111',
          external_id: 'ERP-1',
          changed_at: '2026-08-29T12:00:00.000Z',
          changed_cursor: '2026-08-29 12:00:00.000000',
          payload: JSON.stringify({ sku: 'SKU-1' }),
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          external_id: null,
          changed_at: '2026-08-29T12:01:00.000Z',
          changed_cursor: '2026-08-29 12:01:00.000000',
          payload: { sku: 'SKU-2' },
        },
      ]),
    };
    const service = new ErpIntegrationService(
      repository as unknown as ErpIntegrationRepository,
      {} as AuditService,
    );

    const result = await service.export('tenant-1', {
      provider: 'SIMULATOR',
      resource: 'PRODUCT',
      limit: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      internalId: '11111111-1111-4111-8111-111111111111',
      externalId: 'ERP-1',
      payload: { sku: 'SKU-1' },
    });
    expect(result.meta.hasMore).toBe(true);
    expect(result.meta.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(repository.exportRows).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, resource: 'PRODUCT' }),
    );
  });

  it('retains a scoped high-water cursor at the end of an incremental export', async () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      external_id: null,
      changed_at: '2026-08-29T12:00:00.000Z',
      changed_cursor: '2026-08-29 12:00:00.000000',
      payload: { sku: 'SKU-1' },
    };
    const repository = { exportRows: jest.fn().mockResolvedValue([row]) };
    const service = new ErpIntegrationService(
      repository as unknown as ErpIntegrationRepository,
      {} as AuditService,
    );

    const first = await service.export('tenant-1', {
      provider: 'SIMULATOR',
      resource: 'PRODUCT',
      limit: 1,
    });
    expect(first.meta.hasMore).toBe(false);
    expect(first.meta.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    repository.exportRows.mockResolvedValueOnce([]);
    const next = await service.export('tenant-1', {
      provider: 'SIMULATOR',
      resource: 'PRODUCT',
      limit: 1,
      cursor: first.meta.nextCursor!,
    });
    expect(next.meta.nextCursor).toBe(first.meta.nextCursor);
    expect(repository.exportRows).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: {
          changedAt: row.changed_cursor,
          id: row.id,
        },
      }),
    );

    await expect(
      service.export('tenant-2', {
        provider: 'SIMULATOR',
        resource: 'PRODUCT',
        limit: 1,
        cursor: first.meta.nextCursor!,
      }),
    ).rejects.toThrow('ERP_CURSOR_INVALID');
  });
});

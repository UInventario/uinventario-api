import { createHash, createHmac } from 'node:crypto';
import type { SessionIdentity } from '../auth/session/session.types';
import { OfflineBootstrapRepository } from './offline-bootstrap.repository';
import { OfflineChangesRepository } from './offline-changes.repository';
import { OfflineChangesService } from './offline-changes.service';

describe('OfflineChangesService', () => {
  const sessionId = 'server-session-id';
  const principal = {
    sessionId,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      roles: ['ADMIN'],
      permissions: ['INVENTORY_VIEW'],
    },
    tenant: { id: 'tenant-1', name: 'Tenant' },
    context: { branch: null, warehouse: null, cashRegister: null },
  } as SessionIdentity;
  const bootstrapRepository = { entities: jest.fn() };
  const changesRepository = { tombstones: jest.fn() };
  const service = new OfflineChangesService(
    bootstrapRepository as unknown as OfflineBootstrapRepository,
    changesRepository as unknown as OfflineChangesRepository,
  );

  beforeEach(() => {
    bootstrapRepository.entities.mockReset();
    changesRepository.tombstones.mockReset().mockResolvedValue([]);
  });

  it('uses a stable watermark and resumes the next bounded page', async () => {
    const snapshotAt = new Date(Date.now() - 60_000).toISOString();
    bootstrapRepository.entities.mockResolvedValue([
      entity('product-1', new Date(Date.now() - 40_000).toISOString()),
      entity('product-2', new Date(Date.now() - 30_000).toISOString()),
    ]);
    const cursor = encodeCursor(snapshotAt);

    const first = await service.changes(principal, {
      deviceId: '10000000-0000-4000-8000-000000000001',
      cursor,
      pageSize: 1,
    });
    const retry = await service.changes(principal, {
      deviceId: '10000000-0000-4000-8000-000000000001',
      cursor,
      pageSize: 1,
    });
    const second = await service.changes(principal, {
      deviceId: '10000000-0000-4000-8000-000000000001',
      cursor: first.nextCursor,
      pageSize: 1,
    });

    expect(first.hasMore).toBe(true);
    expect(first.changes.map(({ entity: value }) => value.id)).toEqual([
      'product-1',
    ]);
    expect(retry.changes).toEqual(first.changes);
    expect(second.hasMore).toBe(false);
    expect(second.changes.map(({ entity: value }) => value.id)).toEqual([
      'product-2',
    ]);
  });

  it('requires controlled full resynchronization for an expired cursor', async () => {
    await expect(
      service.changes(principal, {
        deviceId: '10000000-0000-4000-8000-000000000001',
        cursor: encodeCursor(
          new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
        ),
        pageSize: 100,
      }),
    ).rejects.toMatchObject({
      response: { code: 'OFFLINE_SYNC_CURSOR_EXPIRED' },
    });
    expect(bootstrapRepository.entities).not.toHaveBeenCalled();
  });

  function entity(id: string, updatedAt: string) {
    return {
      kind: 'PRODUCT' as const,
      id,
      tenantId: 'tenant-1',
      version: 1,
      updatedAt,
      sku: id,
      barcode: null,
      name: id,
      categoryId: null,
      brandId: null,
      price: '1.00',
      active: true,
    };
  }

  function encodeCursor(snapshotAt: string): string {
    const payload = {
      kind: 'bootstrap',
      protocolVersion: '1.0',
      sessionBinding: createHash('sha256')
        .update(sessionId)
        .digest('base64url'),
      tenantId: 'tenant-1',
      userId: 'user-1',
      deviceId: '10000000-0000-4000-8000-000000000001',
      offset: 0,
      snapshotAt,
      authorizedBranchIds: [],
      authorizedCashRegisterIds: [],
      administrator: true,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', sessionId)
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }
});

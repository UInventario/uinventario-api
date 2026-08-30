import type { DataSource, EntityManager } from 'typeorm';
import { AccountingRepository } from './accounting.repository';

describe('AccountingRepository', () => {
  it('replays a completed delivery key without exporting twice', async () => {
    const stored = {
      id: 'event-1',
      eventKey: 'SALE:sale-1',
      sourceType: 'SALE',
      sourceId: 'sale-1',
      provider: 'SIMULATOR',
      contractVersion: '1',
      currency: 'MXN',
      occurredAt: '2026-08-29T12:00:00.000Z',
      reference: 'S-1',
      journalStatus: 'CANDIDATE_NOT_POSTED',
      entries: [],
      debitTotal: '116.00',
      creditTotal: '116.00',
      status: 'EXPORTED',
      attemptCount: 1,
      errorCode: null,
      providerReference: 'ACC-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      updatedAt: '2026-08-29T12:00:00.000Z',
    };
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            event_id: 'event-1',
            action: 'DELIVER',
            request_fingerprint: 'fingerprint',
            result: JSON.stringify(stored),
          },
        ]),
    } as unknown as EntityManager;
    const repository = new AccountingRepository({
      transaction: jest.fn((work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource);
    const execute = jest.fn();

    await expect(
      repository.attempt({
        tenantId: 'tenant-1',
        eventId: 'event-1',
        action: 'DELIVER',
        scenario: 'SUCCESS',
        idempotencyKey: 'delivery-001',
        fingerprint: 'fingerprint',
        correlationId: 'request-1',
        execute,
      }),
    ).resolves.toEqual({ event: stored, replay: true });
    expect(execute).not.toHaveBeenCalled();
  });
});

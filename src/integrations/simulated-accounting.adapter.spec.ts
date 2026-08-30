import type { AccountingEventData } from './accounting.types';
import { SimulatedAccountingAdapter } from './simulated-accounting.adapter';

const event: AccountingEventData = {
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
  status: 'PENDING',
  attemptCount: 0,
  errorCode: null,
  providerReference: null,
  createdAt: '2026-08-29T12:00:00.000Z',
  updatedAt: '2026-08-29T12:00:00.000Z',
};

describe('SimulatedAccountingAdapter', () => {
  const adapter = new SimulatedAccountingAdapter();

  it('returns a stable provider reference for safe retries', () => {
    expect(adapter.deliver(event, 'SUCCESS')).toEqual(
      adapter.deliver(event, 'SUCCESS'),
    );
  });

  it('models rejection and timeout without mutating the candidate', () => {
    expect(adapter.deliver(event, 'REJECT')).toMatchObject({
      status: 'REJECTED',
    });
    const timeout = adapter.deliver(event, 'TIMEOUT');
    expect(timeout).toMatchObject({ status: 'INDETERMINATE' });
    expect(adapter.reconcile({ ...event, ...timeout })).toMatchObject({
      status: 'EXPORTED',
      errorCode: null,
    });
    expect(event.status).toBe('PENDING');
  });
});

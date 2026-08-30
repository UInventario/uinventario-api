import type { DataSource, EntityManager } from 'typeorm';
import { PspPaymentRepository } from './psp-payment.repository';

const payment = {
  id: 'payment-1',
  provider: 'SIMULATOR',
  adapterVersion: '1',
  providerReference: 'PSP-111111111111111111111111',
  merchantReference: 'ORDER-1',
  amount: '100.00',
  refundedAmount: '0.00',
  currency: 'MXN',
  status: 'CAPTURED',
  scenario: 'SUCCESS',
  errorCode: null,
  correlationId: 'request-1',
  createdAt: '2026-08-29T12:00:00.000Z',
  updatedAt: '2026-08-29T12:00:00.000Z',
};

describe('PspPaymentRepository', () => {
  it('replays an action with the same key without executing it twice', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            payment_id: payment.id,
            action: 'CAPTURE',
            request_fingerprint: 'fingerprint',
            result: JSON.stringify(payment),
          },
        ]),
    } as unknown as EntityManager;
    const repository = new PspPaymentRepository({
      transaction: jest.fn((work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource);
    const execute = jest.fn();

    const result = await repository.action({
      tenantId: 'tenant-1',
      paymentId: payment.id,
      action: 'CAPTURE',
      idempotencyKey: 'capture-001',
      fingerprint: 'fingerprint',
      correlationId: 'request-1',
      execute,
    });

    expect(result).toEqual({ payment, replay: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('deduplicates a webhook event and preserves its out-of-order result', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ affectedRows: 0 })
        .mockResolvedValueOnce([
          {
            payment_id: payment.id,
            event_fingerprint: 'fingerprint',
            ignored_out_of_order: true,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: payment.id,
            provider: payment.provider,
            adapter_version: payment.adapterVersion,
            provider_reference: payment.providerReference,
            merchant_reference: payment.merchantReference,
            amount: payment.amount,
            refunded_amount: payment.refundedAmount,
            currency: payment.currency,
            status: payment.status,
            scenario: payment.scenario,
            error_code: null,
            correlation_id: payment.correlationId,
            created_at: payment.createdAt,
            updated_at: payment.updatedAt,
          },
        ]),
    } as unknown as EntityManager;
    const repository = new PspPaymentRepository({
      transaction: jest.fn((work: (value: EntityManager) => unknown) =>
        work(manager),
      ),
    } as unknown as DataSource);
    const advance = jest.fn();

    const result = await repository.webhook({
      tenantId: 'tenant-1',
      eventId: 'event-001',
      providerReference: payment.providerReference,
      status: 'AUTHORIZED',
      occurredAt: payment.updatedAt,
      fingerprint: 'fingerprint',
      advance,
    });

    expect(result).toEqual({ payment, replay: true, ignoredOutOfOrder: true });
    expect(advance).not.toHaveBeenCalled();
  });
});

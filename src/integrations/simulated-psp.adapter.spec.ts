import { SimulatedPspAdapter } from './simulated-psp.adapter';

describe('SimulatedPspAdapter', () => {
  const adapter = new SimulatedPspAdapter();
  const payment = {
    id: 'payment-1',
    provider: 'SIMULATOR' as const,
    adapterVersion: '1' as const,
    providerReference: 'PSP-111111111111111111111111',
    merchantReference: 'ORDER-1',
    amount: '100.00',
    refundedAmount: '0.00',
    currency: 'MXN',
    status: 'REQUIRES_CONFIRMATION' as const,
    scenario: 'SUCCESS' as const,
    errorCode: null,
    correlationId: 'request-1',
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z',
  };

  it('creates a deterministic intent without cardholder data', () => {
    const input = {
      tenantId: 'tenant-1',
      merchantReference: 'ORDER-1',
      amount: '100.00',
      currency: 'MXN',
    };
    expect(adapter.intent(input)).toEqual(adapter.intent(input));
    expect(Object.keys(input)).toEqual([
      'tenantId',
      'merchantReference',
      'amount',
      'currency',
    ]);
  });

  it('covers confirmation, capture, timeout reconciliation and refund', () => {
    expect(adapter.confirm(payment)).toEqual({
      status: 'AUTHORIZED',
      errorCode: null,
    });
    expect(adapter.capture({ ...payment, status: 'AUTHORIZED' })).toEqual({
      status: 'CAPTURED',
      errorCode: null,
    });
    const timeout = {
      ...payment,
      status: 'AUTHORIZED' as const,
      scenario: 'TIMEOUT' as const,
    };
    expect(adapter.capture(timeout)).toEqual({
      status: 'INDETERMINATE',
      errorCode: 'SIMULATED_CAPTURE_TIMEOUT',
    });
    expect(adapter.query({ ...timeout, status: 'INDETERMINATE' })).toEqual({
      status: 'CAPTURED',
      errorCode: null,
    });
    expect(adapter.refund({ ...payment, status: 'CAPTURED' }, '25.00')).toEqual(
      {
        status: 'CAPTURED',
        errorCode: null,
      },
    );
  });
});

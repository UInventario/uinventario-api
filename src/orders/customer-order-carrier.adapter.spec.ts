import {
  type CustomerOrderCarrierPayload,
  SimulatorCustomerOrderCarrierAdapter,
} from './customer-order-carrier.adapter';

describe('SimulatorCustomerOrderCarrierAdapter', () => {
  const payload: CustomerOrderCarrierPayload = {
    carrierCode: 'SIMULATED_RETRY',
    orderNumber: 'O-123',
    currency: 'MXN',
    windowStart: '2026-08-30T12:00:00.000Z',
    windowEnd: '2026-08-30T18:00:00.000Z',
    recipient: { name: 'Persona privada', phone: '+525512349876' },
    address: {
      line1: 'Calle Privada 123',
      line2: null,
      city: 'Ciudad de México',
      region: 'CDMX',
      postalCode: '01000',
      countryCode: 'MX',
    },
    parcels: [{ sku: 'SKU-1', quantity: '2.000' }],
  };

  it('quotes and creates a printable label after a simulated timeout', async () => {
    const adapter = new SimulatorCustomerOrderCarrierAdapter();

    await expect(adapter.quote(payload)).resolves.toMatchObject({
      quoteReference: 'QUOTE-O-123',
      amount: '85.00',
      currency: 'MXN',
    });
    await expect(
      adapter.createShipment({
        ...payload,
        attempt: 1,
        idempotencyKey: 'shipment-attempt-1',
      }),
    ).resolves.toEqual({
      status: 'FAILED_RETRYABLE',
      errorCode: 'SIMULATED_CARRIER_TIMEOUT',
    });
    const shipment = await adapter.createShipment({
      ...payload,
      attempt: 2,
      idempotencyKey: 'shipment-attempt-2',
    });
    expect(shipment).toMatchObject({
      status: 'SUCCEEDED',
      trackingStatus: 'LABEL_READY',
      label: { format: 'ZPL' },
    });
    if (shipment.status !== 'SUCCEEDED') throw new Error('shipment expected');
    expect(shipment.label.payload).toContain('^XA');
    expect(JSON.stringify(shipment)).not.toContain(payload.address.line1);
    expect(JSON.stringify(shipment)).not.toContain(payload.recipient.phone);
  });

  it('supports cancellation fallback and polling statuses', async () => {
    const adapter = new SimulatorCustomerOrderCarrierAdapter();
    await expect(
      adapter.cancel({
        trackingReference: 'SIM-O-123-2',
        scenario: 'TIMEOUT',
        idempotencyKey: 'carrier-cancel-timeout',
      }),
    ).resolves.toEqual({
      status: 'FAILED_RETRYABLE',
      errorCode: 'SIMULATED_CARRIER_CANCEL_TIMEOUT',
    });
    await expect(
      adapter.cancel({
        trackingReference: 'SIM-O-123-2',
        scenario: 'SUCCESS',
        idempotencyKey: 'carrier-cancel-success',
      }),
    ).resolves.toEqual({ status: 'CANCELLED' });
    await expect(
      adapter.track({
        trackingReference: 'SIM-O-123-2',
        currentSequence: 4,
        scenario: 'DELIVERED',
        idempotencyKey: 'carrier-poll-delivered',
      }),
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      event: { status: 'DELIVERED', sequence: 5 },
    });
  });
});

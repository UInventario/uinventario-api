import { createHmac } from 'node:crypto';
import type { CustomerOrderEventBus } from '../orders/customer-order-event.bus';
import type { CustomerOrderData } from '../orders/customer-order.types';
import type { CommerceRepository } from './commerce.repository';
import { CommerceWebhookService } from './commerce-webhook.service';

describe('CommerceWebhookService', () => {
  let capturedDelivery:
    Parameters<CommerceRepository['createDelivery']>[0] | undefined;
  const repository = {
    webhookConfiguration: jest.fn<
      ReturnType<CommerceRepository['webhookConfiguration']>,
      Parameters<CommerceRepository['webhookConfiguration']>
    >(),
    createDelivery: jest.fn<
      ReturnType<CommerceRepository['createDelivery']>,
      Parameters<CommerceRepository['createDelivery']>
    >(),
    updateDelivery: jest.fn<
      ReturnType<CommerceRepository['updateDelivery']>,
      Parameters<CommerceRepository['updateDelivery']>
    >(),
  };
  const eventBus = { subscribe: jest.fn() };
  const service = new CommerceWebhookService(
    repository as unknown as CommerceRepository,
    eventBus as unknown as CustomerOrderEventBus,
  );
  const tenantId = '20000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    jest.clearAllMocks();
    capturedDelivery = undefined;
  });

  it('signs a deduplicated event and retries a simulated timeout', async () => {
    repository.webhookConfiguration.mockResolvedValue({
      credentialId: '10000000-0000-4000-8000-000000000001',
      externalOrderId: 'market-1001',
      keyHash: 'a'.repeat(64),
      url: 'https://retry.example.test/webhook',
      events: ['ORDER_CONFIRMED'],
    });
    repository.createDelivery.mockImplementation(
      (input: Parameters<CommerceRepository['createDelivery']>[0]) => {
        capturedDelivery = input;
        return Promise.resolve({
          id: 'delivery',
          eventId: input.eventId,
          eventType: input.eventType,
          targetUrl: input.targetUrl,
          signature: input.signature,
          status: 'PENDING',
          attemptCount: 0,
          errorCode: null,
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:00:00.000Z',
          deliveredAt: null,
        });
      },
    );
    const order = confirmedOrder();

    await service.publishOrder(tenantId, order);

    expect(capturedDelivery).toBeDefined();
    const deliveryInput = capturedDelivery!;
    expect(deliveryInput.eventId).toBe(
      `${order.id}:ORDER_CONFIRMED:${order.version}`,
    );
    expect(deliveryInput.tenantId).toBe(tenantId);
    expect(deliveryInput.signature).toBe(
      `sha256=${createHmac('sha256', 'a'.repeat(64))
        .update(JSON.stringify(deliveryInput.payload))
        .digest('hex')}`,
    );
    expect(repository.updateDelivery).toHaveBeenNthCalledWith(1, 'delivery', {
      status: 'RETRYABLE_FAILURE',
      errorCode: 'SIMULATED_TIMEOUT',
    });
    expect(repository.updateDelivery).toHaveBeenNthCalledWith(2, 'delivery', {
      status: 'SUCCEEDED',
      errorCode: null,
    });
  });

  it('does not redeliver an event already marked successful', async () => {
    repository.webhookConfiguration.mockResolvedValue({
      credentialId: 'credential',
      externalOrderId: 'market-1001',
      keyHash: 'b'.repeat(64),
      url: 'https://example.test/webhook',
      events: ['ORDER_CONFIRMED'],
    });
    repository.createDelivery.mockResolvedValue({
      id: 'delivery',
      eventId: 'event',
      eventType: 'ORDER_CONFIRMED',
      targetUrl: 'https://example.test/webhook',
      signature: `sha256=${'c'.repeat(64)}`,
      status: 'SUCCEEDED',
      attemptCount: 1,
      errorCode: null,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      deliveredAt: '2026-08-30T00:00:00.000Z',
    });

    await service.publishOrder(tenantId, confirmedOrder());

    expect(repository.updateDelivery).not.toHaveBeenCalled();
  });
});

function confirmedOrder(): CustomerOrderData {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    orderNumber: 'ORD-1',
    channel: 'WEB',
    priority: 'NORMAL',
    status: 'CONFIRMED',
    version: 2,
    customer: { id: 'c', name: 'Cliente', identifier: null },
    context: {
      branch: { id: 'b', name: 'Sucursal' },
      warehouse: { id: 'w', name: 'Bodega' },
      cashRegister: { id: 'r', name: 'Caja', code: 'C1' },
      location: { id: 'l', name: 'Ubicación', code: 'L1' },
    },
    currency: 'MXN',
    totals: { subtotal: '50.00', tax: '0.00', total: '50.00' },
    expiresInHours: 24,
    fulfillment: {
      method: 'PICKUP',
      status: 'READY',
      deliveryCost: '0.00',
      window: { start: '', end: '' },
      address: null,
      carrier: null,
      responsible: { preparation: null, delivery: null },
    },
    reservation: null,
    sale: null,
    lines: [],
    payments: [],
    transitions: [],
    cancellationReason: null,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}

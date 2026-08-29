import { ExternalAdapterExecutionService } from '../integrations/external-adapter-execution.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationRepository } from './notification.repository';

describe('NotificationDeliveryService', () => {
  const delivery = {
    id: 'delivery-1',
    notification_id: 'notification-1',
    recipient_user_id: 'user-1',
    email: 'operator@example.com',
    event_type: 'STOCK_LOW' as const,
    title: 'Stock bajo',
    body: 'Producto con stock bajo.',
    channel: 'EMAIL' as const,
    adapter: 'SIMULATOR',
    status: 'PROCESSING' as const,
    attempt_count: 1,
    next_attempt_at: new Date(),
    error_code: null,
    delivered_at: null,
  };

  it('stores a generic failure and succeeds on a later retry without logging recipient data', async () => {
    const repository = {
      claimDueDeliveries: jest
        .fn()
        .mockResolvedValueOnce([delivery])
        .mockResolvedValueOnce([{ ...delivery, attempt_count: 2 }]),
      markDeliveryFailed: jest.fn().mockResolvedValue(undefined),
      markDeliverySent: jest.fn().mockResolvedValue(undefined),
    };
    const adapters = {
      execute: jest
        .fn()
        .mockRejectedValueOnce(new Error('provider included sensitive details'))
        .mockResolvedValueOnce({
          status: 'SUCCEEDED',
          providerReference: 'SIM-EMAIL-safe',
        }),
    };
    const service = new NotificationDeliveryService(
      repository as unknown as NotificationRepository,
      adapters as unknown as ExternalAdapterExecutionService,
    );

    await expect(service.process('tenant-1')).resolves.toEqual({
      sent: 0,
      failed: 1,
    });
    expect(repository.markDeliveryFailed).toHaveBeenCalledWith(
      'delivery-1',
      1,
      'ADAPTER_DELIVERY_FAILED',
    );

    await expect(service.process('tenant-1')).resolves.toEqual({
      sent: 1,
      failed: 0,
    });
    expect(repository.markDeliverySent).toHaveBeenCalledWith(
      'delivery-1',
      'SIM-EMAIL-safe',
    );
    expect(adapters.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        capability: 'NOTIFICATION_EMAIL',
        idempotencyKey: 'delivery-1:2',
      }),
    );
  });
});

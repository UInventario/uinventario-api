import { InventoryStockAlertRepository } from '../inventory/inventory-stock-alert.repository';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  const setup = () => {
    const repository = {
      reconcile: jest.fn().mockResolvedValue({ created: 2, deduplicated: 3 }),
      replacePreferences: jest.fn().mockResolvedValue([]),
    };
    const stock = { reconcileTenant: jest.fn().mockResolvedValue(undefined) };
    const delivery = {
      process: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }),
    };
    const service = new NotificationService(
      repository as unknown as NotificationRepository,
      stock as unknown as InventoryStockAlertRepository,
      delivery as unknown as NotificationDeliveryService,
    );
    return { service, repository, stock, delivery };
  };

  it('reconciles alert state before deduplicating and delivering tenant notifications', async () => {
    const { service, repository, stock, delivery } = setup();

    await expect(service.refresh('tenant-1')).resolves.toEqual({
      data: {
        reconciliation: { created: 2, deduplicated: 3 },
        delivery: { sent: 1, failed: 0 },
      },
      meta: { apiVersion: '1' },
    });
    expect(stock.reconcileTenant).toHaveBeenCalledWith('tenant-1');
    expect(repository.reconcile).toHaveBeenCalledWith('tenant-1');
    expect(delivery.process).toHaveBeenCalledWith('tenant-1');
  });

  it('rejects duplicate rules and enabled rules without a channel', async () => {
    const { service, repository } = setup();
    const rule = {
      recipientUserId: '7efc799b-2086-4cb6-808d-bfa682543757',
      eventType: 'STOCK_LOW' as const,
      enabled: true,
      inApp: true,
      email: false,
      push: false,
      frequency: 'IMMEDIATE' as const,
    };

    await expect(
      service.replacePreferences('tenant-1', { preferences: [rule, rule] }),
    ).rejects.toMatchObject({
      response: { message: 'DUPLICATE_NOTIFICATION_PREFERENCE' },
    });
    await expect(
      service.replacePreferences('tenant-1', {
        preferences: [{ ...rule, inApp: false }],
      }),
    ).rejects.toMatchObject({
      response: { message: 'NOTIFICATION_CHANNEL_REQUIRED' },
    });
    expect(repository.replacePreferences).not.toHaveBeenCalled();
  });
});

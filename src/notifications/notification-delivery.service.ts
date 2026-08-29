import { Injectable } from '@nestjs/common';
import { NotificationRepository } from './notification.repository';
import {
  SimulatedEmailNotificationAdapter,
  SimulatedPushNotificationAdapter,
  type NotificationChannelAdapter,
} from './notification-channel.adapter';

@Injectable()
export class NotificationDeliveryService {
  private readonly adapters: Map<string, NotificationChannelAdapter>;

  constructor(
    private readonly notifications: NotificationRepository,
    email: SimulatedEmailNotificationAdapter,
    push: SimulatedPushNotificationAdapter,
  ) {
    this.adapters = new Map<string, NotificationChannelAdapter>([
      [email.channel, email],
      [push.channel, push],
    ]);
  }

  async process(tenantId: string): Promise<{ sent: number; failed: number }> {
    const deliveries = await this.notifications.claimDueDeliveries(tenantId);
    let sent = 0;
    let failed = 0;
    for (const delivery of deliveries) {
      const adapter = this.adapters.get(delivery.channel);
      try {
        if (!adapter) throw new Error('ADAPTER_NOT_CONFIGURED');
        const result = await adapter.send({
          notificationId: delivery.notification_id,
          channel: delivery.channel,
          recipient: delivery.email,
          title: delivery.title,
          body: delivery.body,
        });
        await this.notifications.markDeliverySent(
          delivery.id,
          result.providerReference,
        );
        sent++;
      } catch (error) {
        const code =
          error instanceof Error && error.message === 'ADAPTER_NOT_CONFIGURED'
            ? 'ADAPTER_NOT_CONFIGURED'
            : 'ADAPTER_DELIVERY_FAILED';
        await this.notifications.markDeliveryFailed(
          delivery.id,
          Number(delivery.attempt_count),
          code,
        );
        failed++;
      }
    }
    return { sent, failed };
  }
}

import { Injectable } from '@nestjs/common';
import { ExternalAdapterExecutionService } from '../integrations/external-adapter-execution.service';
import { NotificationRepository } from './notification.repository';

@Injectable()
export class NotificationDeliveryService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly adapters: ExternalAdapterExecutionService,
  ) {}

  async process(tenantId: string): Promise<{ sent: number; failed: number }> {
    const deliveries = await this.notifications.claimDueDeliveries(tenantId);
    let sent = 0;
    let failed = 0;
    for (const delivery of deliveries) {
      try {
        const result = await this.adapters.execute({
          tenantId,
          capability:
            delivery.channel === 'EMAIL'
              ? 'NOTIFICATION_EMAIL'
              : 'NOTIFICATION_PUSH',
          idempotencyKey: `${delivery.id}:${delivery.attempt_count}`,
          correlationId: `notification:${delivery.notification_id}`,
          payload: {
            recipient: delivery.email,
            title: delivery.title,
            body: delivery.body,
          },
        });
        if (result.status !== 'SUCCEEDED')
          throw new Error(result.errorCode ?? 'ADAPTER_DELIVERY_FAILED');
        await this.notifications.markDeliverySent(
          delivery.id,
          result.providerReference!,
        );
        sent++;
      } catch (error) {
        const code =
          error instanceof Error &&
          [
            'ADAPTER_DISABLED',
            'ADAPTER_NOT_CONFIGURED',
            'ADAPTER_TIMEOUT',
            'SIMULATED_REJECTED',
          ].includes(error.message)
            ? error.message
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

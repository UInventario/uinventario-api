import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { NotificationDeliveryChannel } from './notification.types';

export interface NotificationDeliveryMessage {
  notificationId: string;
  channel: NotificationDeliveryChannel;
  recipient: string;
  title: string;
  body: string;
}

export interface NotificationChannelAdapter {
  readonly channel: NotificationDeliveryChannel;
  send(
    message: NotificationDeliveryMessage,
  ): Promise<{ providerReference: string }>;
}

abstract class SimulatedNotificationAdapter implements NotificationChannelAdapter {
  abstract readonly channel: NotificationDeliveryChannel;

  send(
    message: NotificationDeliveryMessage,
  ): Promise<{ providerReference: string }> {
    const reference = createHash('sha256')
      .update(`${this.channel}:${message.notificationId}`)
      .digest('hex')
      .slice(0, 24);
    return Promise.resolve({
      providerReference: `SIM-${this.channel}-${reference}`,
    });
  }
}

@Injectable()
export class SimulatedEmailNotificationAdapter extends SimulatedNotificationAdapter {
  readonly channel = 'EMAIL' as const;
}

@Injectable()
export class SimulatedPushNotificationAdapter extends SimulatedNotificationAdapter {
  readonly channel = 'PUSH' as const;
}

import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Webhook } from 'svix';
import { emailProviderConfig } from '../config/email-provider.config';
import { ExternalAdapterRepository } from './external-adapter.repository';
import type { ExternalEmailEventType } from './external-adapter.types';

const EVENT_TYPES: Record<string, ExternalEmailEventType> = {
  'email.sent': 'SENT',
  'email.delivered': 'DELIVERED',
  'email.delivery_delayed': 'DELIVERY_DELAYED',
  'email.bounced': 'BOUNCED',
  'email.failed': 'FAILED',
  'email.suppressed': 'SUPPRESSED',
  'email.complained': 'COMPLAINED',
};

interface ResendWebhookEvent {
  type?: string;
  created_at?: string;
  data?: { email_id?: string };
}

@Injectable()
export class ResendWebhookService {
  constructor(
    @Inject(emailProviderConfig.KEY)
    private readonly config: ConfigType<typeof emailProviderConfig>,
    private readonly repository: ExternalAdapterRepository,
  ) {}

  async receive(input: {
    payload: Buffer | undefined;
    id: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
  }): Promise<{ received: true; recorded: boolean }> {
    const secret = this.config.resend?.webhookSecret;
    if (!secret) throw new NotFoundException();
    if (!input.payload || !input.id || !input.timestamp || !input.signature)
      throw new BadRequestException('INVALID_WEBHOOK_SIGNATURE');

    let event: ResendWebhookEvent;
    try {
      event = new Webhook(secret).verify(input.payload.toString('utf8'), {
        'svix-id': input.id,
        'svix-timestamp': input.timestamp,
        'svix-signature': input.signature,
      }) as ResendWebhookEvent;
    } catch {
      throw new BadRequestException('INVALID_WEBHOOK_SIGNATURE');
    }
    const eventType = event.type ? EVENT_TYPES[event.type] : undefined;
    const providerReference = event.data?.email_id;
    const occurredAt = event.created_at ? new Date(event.created_at) : null;
    if (
      !eventType ||
      !providerReference ||
      !occurredAt ||
      Number.isNaN(occurredAt.getTime())
    ) {
      return { received: true, recorded: false };
    }
    const errorCode =
      eventType === 'BOUNCED'
        ? 'EMAIL_BOUNCED'
        : eventType === 'FAILED'
          ? 'EMAIL_DELIVERY_FAILED'
          : eventType === 'SUPPRESSED'
            ? 'EMAIL_SUPPRESSED'
            : eventType === 'COMPLAINED'
              ? 'EMAIL_COMPLAINT'
              : eventType === 'DELIVERY_DELAYED'
                ? 'EMAIL_DELIVERY_DELAYED'
                : null;
    return {
      received: true,
      recorded: await this.repository.recordEmailEvent({
        webhookEventId: input.id,
        provider: 'RESEND',
        providerReference,
        eventType,
        errorCode,
        occurredAt,
      }),
    };
  }
}

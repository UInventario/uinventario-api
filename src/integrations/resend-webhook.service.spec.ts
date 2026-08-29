import { BadRequestException } from '@nestjs/common';
import { Webhook } from 'svix';
import { ExternalAdapterRepository } from './external-adapter.repository';
import { ResendWebhookService } from './resend-webhook.service';

describe('ResendWebhookService', () => {
  const webhookSecret = 'whsec_dGVzdC13ZWJob29rLXNlY3JldA==';
  const config = {
    baseUrl: 'https://api.resend.com',
    secretReference: 'uinventario-dev-resend-config',
    resend: {
      apiKey: 're_test_value',
      from: 'noreply@example.com',
      diagnosticRecipient: 'sandbox@example.com',
      webhookSecret,
    },
  };

  it('verifies and stores only sanitized bounce metadata idempotently', async () => {
    const repository = { recordEmailEvent: jest.fn().mockResolvedValue(true) };
    const service = new ResendWebhookService(
      config,
      repository as unknown as ExternalAdapterRepository,
    );
    const payload = JSON.stringify({
      type: 'email.bounced',
      created_at: '2026-08-29T12:00:00.000Z',
      data: {
        email_id: 'email-1',
        to: ['sensitive@example.com'],
        bounce: { message: 'sensitive provider detail' },
      },
    });
    const id = 'event-1';
    const timestamp = new Date();
    const signature = new Webhook(webhookSecret).sign(id, timestamp, payload);

    await expect(
      service.receive({
        payload: Buffer.from(payload),
        id,
        timestamp: String(Math.floor(timestamp.getTime() / 1000)),
        signature,
      }),
    ).resolves.toEqual({ received: true, recorded: true });
    expect(repository.recordEmailEvent).toHaveBeenCalledWith({
      webhookEventId: id,
      provider: 'RESEND',
      providerReference: 'email-1',
      eventType: 'BOUNCED',
      errorCode: 'EMAIL_BOUNCED',
      occurredAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    expect(
      JSON.stringify(repository.recordEmailEvent.mock.calls),
    ).not.toContain('sensitive@example.com');
  });

  it('rejects invalid signatures', async () => {
    const service = new ResendWebhookService(config, {
      recordEmailEvent: jest.fn(),
    } as unknown as ExternalAdapterRepository);
    await expect(
      service.receive({
        payload: Buffer.from('{}'),
        id: 'event-2',
        timestamp: '1',
        signature: 'v1,invalid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

import { createHash } from 'node:crypto';
import type { ExternalAdapterExecutionService } from './external-adapter-execution.service';
import { WhatsappConsentRequiredError } from './whatsapp.errors';
import type { WhatsappRepository } from './whatsapp.repository';
import { WhatsappService } from './whatsapp.service';
import type { WhatsappMessageData } from './whatsapp.types';

const pending: WhatsappMessageData = {
  id: 'message-1',
  customer: { id: 'customer-1', name: 'Ada' },
  template: { key: 'WHATSAPP_SALE_RECEIPT', version: '1' },
  reference: 'SALE-100',
  recipientMasked: '***4567',
  provider: 'SIMULATOR',
  providerReference: null,
  status: 'PENDING',
  errorCode: null,
  lastEventAt: null,
  createdAt: '2026-08-30T12:00:00.000Z',
  updatedAt: '2026-08-30T12:00:00.000Z',
};

describe('WhatsappService', () => {
  const sendInput = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    customerId: 'customer-1',
    idempotencyKey: 'whatsapp-send-001',
    correlationId: 'request-1',
    dto: {
      templateKey: 'WHATSAPP_SALE_RECEIPT' as const,
      reference: 'SALE-100',
      scenario: 'SUCCESS' as const,
    },
  };

  it('blocks sends without explicit consent before calling the adapter', async () => {
    const repository = {
      begin: jest.fn().mockRejectedValue(new WhatsappConsentRequiredError()),
    };
    const executor = { execute: jest.fn() };
    const service = new WhatsappService(
      repository as unknown as WhatsappRepository,
      executor as unknown as ExternalAdapterExecutionService,
    );

    await expect(service.send(sendInput)).rejects.toMatchObject({
      response: { code: 'WHATSAPP_CONSENT_REQUIRED' },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('uses a fixed template and returns a one-time simulator webhook token', async () => {
    const sent = {
      ...pending,
      status: 'SENT' as const,
      providerReference: 'SIM-111111111111111111111111',
    };
    const repository = {
      begin: jest.fn().mockResolvedValue({
        message: pending,
        phone: '+52 55 1234 4567',
        replay: false,
      }),
      finish: jest.fn().mockResolvedValue(sent),
    };
    const executor = {
      execute: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: 'SUCCEEDED',
        providerReference: sent.providerReference,
        errorCode: null,
      }),
    };
    const service = new WhatsappService(
      repository as unknown as WhatsappRepository,
      executor as unknown as ExternalAdapterExecutionService,
    );

    const result = await service.send(sendInput);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'NOTIFICATION_WHATSAPP',
        payload: {
          recipient: '+52 55 1234 4567',
          title: 'Comprobante',
          body: 'Comprobante disponible: SALE-100',
          template: { key: 'WHATSAPP_SALE_RECEIPT', version: '1' },
        },
      }),
    );
    expect(result.data.recipientMasked).toBe('***4567');
    expect(result.meta.simulatorWebhookToken).toEqual(expect.any(String));
    expect(JSON.stringify(result.data)).not.toContain('+52 55 1234 4567');
  });

  it('verifies and reports idempotent simulator webhooks', async () => {
    const token = 'simulator-webhook-token-001';
    const delivered = { ...pending, status: 'DELIVERED' as const };
    const repository = {
      webhookTarget: jest.fn().mockResolvedValue({
        message: pending,
        webhookTokenHash: createHash('sha256').update(token).digest('hex'),
      }),
      webhook: jest.fn().mockResolvedValue({
        replay: true,
        ignoredOutOfOrder: false,
      }),
      messages: jest.fn().mockResolvedValue([delivered]),
    };
    const service = new WhatsappService(
      repository as unknown as WhatsappRepository,
      {} as ExternalAdapterExecutionService,
    );
    const input = {
      tenantId: 'tenant-1',
      token,
      dto: {
        providerEventId: 'event-0001',
        providerReference: 'SIM-111111111111111111111111',
        status: 'DELIVERED' as const,
        occurredAt: '2026-08-30T12:01:00.000Z',
      },
    };

    await expect(service.webhook(input)).resolves.toMatchObject({
      data: { status: 'DELIVERED' },
      meta: { idempotentReplay: true, ignoredOutOfOrder: false },
    });
    await expect(
      service.webhook({ ...input, token: 'wrong-token' }),
    ).rejects.toMatchObject({
      response: { code: 'WHATSAPP_WEBHOOK_SIGNATURE_INVALID' },
    });
  });
});

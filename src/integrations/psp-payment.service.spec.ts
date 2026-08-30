import { createHash } from 'node:crypto';
import type { AuditService } from '../audit/audit.service';
import type { PspPaymentRepository } from './psp-payment.repository';
import { PspPaymentService } from './psp-payment.service';
import type { PspPaymentData } from './psp-payment.types';
import { SimulatedPspAdapter } from './simulated-psp.adapter';

const base: PspPaymentData = {
  id: 'payment-1',
  provider: 'SIMULATOR',
  adapterVersion: '1',
  providerReference: 'PSP-111111111111111111111111',
  merchantReference: 'ORDER-1',
  amount: '100.00',
  refundedAmount: '0.00',
  currency: 'MXN',
  status: 'AUTHORIZED',
  scenario: 'SUCCESS',
  errorCode: null,
  correlationId: 'request-1',
  createdAt: '2026-08-29T12:00:00.000Z',
  updatedAt: '2026-08-29T12:00:00.000Z',
};

describe('PspPaymentService', () => {
  const audit = { recordRequired: jest.fn().mockResolvedValue(undefined) };

  it('requires reconciliation before retrying an indeterminate capture', async () => {
    const repository = {
      action: jest.fn(
        async (input: { execute: (payment: PspPaymentData) => unknown }) => ({
          payment: await input.execute({
            ...base,
            status: 'INDETERMINATE',
            scenario: 'TIMEOUT',
          }),
          replay: false,
        }),
      ),
    };
    const service = new PspPaymentService(
      repository as unknown as PspPaymentRepository,
      new SimulatedPspAdapter(),
      audit as unknown as AuditService,
    );

    await expect(
      service.capture({
        tenantId: 'tenant-1',
        userId: 'user-1',
        correlationId: 'request-1',
        paymentId: base.id,
        idempotencyKey: 'capture-001',
      }),
    ).rejects.toMatchObject({
      response: { code: 'PSP_RECONCILIATION_REQUIRED' },
    });
  });

  it('refunds partially and then completely without exceeding the capture', async () => {
    let current: PspPaymentData = { ...base, status: 'CAPTURED' };
    const repository = {
      action: jest.fn(
        async (input: {
          execute: (payment: PspPaymentData) => Promise<{
            status: PspPaymentData['status'];
            errorCode: string | null;
            refundedAmount?: string;
          }>;
        }) => {
          const next = await input.execute(current);
          current = {
            ...current,
            status: next.status,
            errorCode: next.errorCode,
            refundedAmount: next.refundedAmount ?? current.refundedAmount,
          };
          return { payment: current, replay: false };
        },
      ),
    };
    const service = new PspPaymentService(
      repository as unknown as PspPaymentRepository,
      new SimulatedPspAdapter(),
      audit as unknown as AuditService,
    );
    const action = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      correlationId: 'request-1',
      paymentId: base.id,
    };

    await expect(
      service.refund({
        ...action,
        idempotencyKey: 'refund-001',
        dto: { amount: '25.00' },
      }),
    ).resolves.toMatchObject({
      data: { status: 'PARTIALLY_REFUNDED', refundedAmount: '25.00' },
    });
    await expect(
      service.refund({
        ...action,
        idempotencyKey: 'refund-002',
        dto: { amount: '75.00' },
      }),
    ).resolves.toMatchObject({
      data: { status: 'REFUNDED', refundedAmount: '100.00' },
    });
  });

  it('verifies and deduplicates webhooks without regressing captured payments', async () => {
    const token = 'simulator-webhook-token-001';
    const repository = {
      webhookTarget: jest.fn().mockResolvedValue({
        payment: { ...base, status: 'CAPTURED' },
        webhookTokenHash: createHash('sha256').update(token).digest('hex'),
      }),
      webhook: jest.fn(
        (input: { advance: (payment: PspPaymentData) => unknown }) => ({
          payment: { ...base, status: 'CAPTURED' },
          replay: false,
          ...(input.advance({ ...base, status: 'CAPTURED' }) as object),
        }),
      ),
    };
    const service = new PspPaymentService(
      repository as unknown as PspPaymentRepository,
      new SimulatedPspAdapter(),
      audit as unknown as AuditService,
    );
    const input = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      correlationId: 'request-1',
      token,
      dto: {
        eventId: 'event-001',
        providerReference: base.providerReference,
        status: 'AUTHORIZED' as const,
        occurredAt: base.updatedAt,
      },
    };

    await expect(service.webhook(input)).resolves.toMatchObject({
      meta: { signatureVerified: true, ignoredOutOfOrder: true },
    });
    await expect(
      service.webhook({ ...input, token: 'wrong-token' }),
    ).rejects.toMatchObject({
      response: { code: 'PSP_WEBHOOK_SIGNATURE_INVALID' },
    });
  });
});

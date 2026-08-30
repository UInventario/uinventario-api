import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { CreatePspIntentDto } from './dto/create-psp-intent.dto';
import type { PspWebhookDto } from './dto/psp-webhook.dto';
import type { RefundPspPaymentDto } from './dto/refund-psp-payment.dto';
import {
  PspIdempotencyConflictError,
  PspPaymentNotFoundError,
} from './psp-payment.errors';
import { PspPaymentRepository } from './psp-payment.repository';
import type {
  PspAction,
  PspPaymentData,
  PspPaymentStatus,
} from './psp-payment.types';
import { SimulatedPspAdapter } from './simulated-psp.adapter';

@Injectable()
export class PspPaymentService {
  constructor(
    private readonly repository: PspPaymentRepository,
    private readonly adapter: SimulatedPspAdapter,
    private readonly audit: AuditService,
  ) {}

  contract() {
    return {
      data: {
        name: 'UINVENTARIO_PSP',
        version: '1',
        activeProvider: {
          key: 'SIMULATOR',
          mode: 'SIMULATOR',
          production: false,
          requiresCardData: false,
        },
        liveProviderProfile: {
          key: 'STRIPE_COMPATIBLE',
          runtimeAvailable: false,
          secretReferences: ['API_KEY', 'WEBHOOK_SIGNING_SECRET'],
        },
        operations: ['INTENT', 'CONFIRM', 'CAPTURE', 'QUERY', 'REFUND'],
        guarantees: {
          tenantScoped: true,
          idempotentMutations: true,
          webhookVerification: true,
          webhookDeduplication: true,
          reconcileBeforeRetry: true,
          cardDataStored: false,
        },
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async list(tenantId: string) {
    return {
      data: await this.repository.list(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async get(tenantId: string, paymentId: string) {
    const payment = await this.repository.find(tenantId, paymentId);
    if (!payment)
      throw new NotFoundException({ code: 'PSP_PAYMENT_NOT_FOUND' });
    return { data: payment, meta: { apiVersion: '1' as const } };
  }

  async create(input: {
    tenantId: string;
    userId: string;
    correlationId: string;
    idempotencyKey: string;
    dto: CreatePspIntentDto;
  }) {
    this.key(input.idempotencyKey);
    const amount = this.money(input.dto.amount);
    if (this.cents(amount) <= 0n) {
      throw new BadRequestException({ code: 'PSP_AMOUNT_INVALID' });
    }
    const request = { ...input.dto, amount };
    const fingerprint = this.fingerprint(request);
    const provider = this.adapter.intent({
      tenantId: input.tenantId,
      merchantReference: input.dto.merchantReference,
      amount,
      currency: input.dto.currency,
    });
    const webhookToken = randomBytes(24).toString('base64url');
    try {
      const result = await this.repository.create({
        tenantId: input.tenantId,
        userId: input.userId,
        providerReference: provider.providerReference,
        merchantReference: input.dto.merchantReference,
        amount,
        currency: input.dto.currency,
        scenario: input.dto.scenario,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        webhookTokenHash: this.hash(webhookToken),
        correlationId: input.correlationId,
      });
      await this.record(
        input,
        'PSP_INTENT_CREATED',
        result.payment,
        result.replay,
      );
      return {
        data: result.payment,
        meta: {
          apiVersion: '1' as const,
          idempotentReplay: result.replay,
          simulatorWebhookToken: result.replay ? null : webhookToken,
        },
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  confirm(input: ActionInput) {
    return this.action(input, 'CONFIRM', (payment) => {
      if (payment.status === 'REQUIRES_CONFIRMATION') {
        return this.adapter.confirm(payment);
      }
      if (['AUTHORIZED', 'DECLINED'].includes(payment.status)) {
        return { status: payment.status, errorCode: payment.errorCode };
      }
      throw new ConflictException({ code: 'PSP_CONFIRM_STATE_INVALID' });
    });
  }

  capture(input: ActionInput) {
    return this.action(input, 'CAPTURE', (payment) => {
      if (payment.status === 'INDETERMINATE') {
        throw new ConflictException({ code: 'PSP_RECONCILIATION_REQUIRED' });
      }
      if (
        ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(payment.status)
      ) {
        return { status: payment.status, errorCode: payment.errorCode };
      }
      if (payment.status !== 'AUTHORIZED') {
        throw new ConflictException({ code: 'PSP_CAPTURE_STATE_INVALID' });
      }
      return this.adapter.capture(payment);
    });
  }

  query(input: ActionInput) {
    return this.action(input, 'QUERY', (payment) =>
      this.adapter.query(payment),
    );
  }

  refund(input: ActionInput & { dto: RefundPspPaymentDto }) {
    const amount = this.money(input.dto.amount);
    return this.action(
      input,
      'REFUND',
      (payment) => {
        if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status)) {
          throw new ConflictException({ code: 'PSP_REFUND_STATE_INVALID' });
        }
        const nextRefunded =
          this.cents(payment.refundedAmount) + this.cents(amount);
        if (
          this.cents(amount) <= 0n ||
          nextRefunded > this.cents(payment.amount)
        ) {
          throw new BadRequestException({ code: 'PSP_REFUND_AMOUNT_INVALID' });
        }
        this.adapter.refund(payment, amount);
        return {
          status:
            nextRefunded === this.cents(payment.amount)
              ? ('REFUNDED' as const)
              : ('PARTIALLY_REFUNDED' as const),
          errorCode: null,
          refundedAmount: this.fromCents(nextRefunded),
        };
      },
      { amount },
    );
  }

  async webhook(input: {
    tenantId: string;
    userId: string;
    correlationId: string;
    token: string;
    dto: PspWebhookDto;
  }) {
    const target = await this.repository.webhookTarget(
      input.tenantId,
      input.dto.providerReference,
    );
    if (!target) throw new NotFoundException({ code: 'PSP_PAYMENT_NOT_FOUND' });
    if (!this.tokenMatches(input.token, target.webhookTokenHash)) {
      throw new UnauthorizedException({
        code: 'PSP_WEBHOOK_SIGNATURE_INVALID',
      });
    }
    const fingerprint = this.fingerprint(input.dto);
    try {
      const result = await this.repository.webhook({
        tenantId: input.tenantId,
        ...input.dto,
        fingerprint,
        advance: (payment) => this.advance(payment, input.dto.status),
      });
      await this.record(
        input,
        'PSP_WEBHOOK_RECEIVED',
        result.payment,
        result.replay,
        {
          eventId: input.dto.eventId,
          ignoredOutOfOrder: result.ignoredOutOfOrder,
        },
      );
      return {
        data: result.payment,
        meta: {
          apiVersion: '1' as const,
          idempotentReplay: result.replay,
          signatureVerified: true,
          ignoredOutOfOrder: result.ignoredOutOfOrder,
        },
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  private async action(
    input: ActionInput,
    action: PspAction,
    execute: (payment: PspPaymentData) =>
      | Promise<{
          status: PspPaymentStatus;
          errorCode: string | null;
          refundedAmount?: string;
        }>
      | {
          status: PspPaymentStatus;
          errorCode: string | null;
          refundedAmount?: string;
        },
    payload: Record<string, unknown> = {},
  ) {
    this.key(input.idempotencyKey);
    const fingerprint = this.fingerprint({
      paymentId: input.paymentId,
      action,
      ...payload,
    });
    try {
      const result = await this.repository.action({
        ...input,
        action,
        fingerprint,
        execute,
      });
      await this.record(input, `PSP_${action}`, result.payment, result.replay);
      return {
        data: result.payment,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  private advance(
    payment: PspPaymentData,
    incoming: 'AUTHORIZED' | 'CAPTURED' | 'DECLINED',
  ) {
    const final = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
    if (final.includes(payment.status)) {
      return {
        status: payment.status,
        ignoredOutOfOrder: incoming !== 'CAPTURED',
      };
    }
    if (payment.status === 'DECLINED') {
      return {
        status: payment.status,
        ignoredOutOfOrder: incoming !== 'DECLINED',
      };
    }
    if (payment.status === 'INDETERMINATE' && incoming !== 'CAPTURED') {
      return { status: payment.status, ignoredOutOfOrder: true };
    }
    if (payment.status === 'AUTHORIZED' && incoming === 'DECLINED') {
      return { status: payment.status, ignoredOutOfOrder: true };
    }
    return { status: incoming, ignoredOutOfOrder: false };
  }

  private async record(
    input: { tenantId: string; userId: string; correlationId: string },
    action: string,
    payment: PspPaymentData,
    replay: boolean,
    extra: Record<string, unknown> = {},
  ) {
    if (replay) return;
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action,
      entityType: 'PSP_PAYMENT',
      entityId: payment.id,
      correlationId: input.correlationId,
      after: { status: payment.status, provider: payment.provider, ...extra },
    });
  }

  private tokenMatches(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(token));
    const expected = Buffer.from(expectedHash);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private key(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
  }

  private fingerprint(value: unknown): string {
    return this.hash(JSON.stringify(value));
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private money(value: string): string {
    return this.fromCents(this.cents(value));
  }

  private cents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  private fromCents(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private mapError(error: unknown): never {
    if (error instanceof PspIdempotencyConflictError) {
      throw new ConflictException({ code: 'PSP_IDEMPOTENCY_CONFLICT' });
    }
    if (error instanceof PspPaymentNotFoundError) {
      throw new NotFoundException({ code: 'PSP_PAYMENT_NOT_FOUND' });
    }
    throw error;
  }
}

interface ActionInput {
  tenantId: string;
  userId: string;
  correlationId: string;
  paymentId: string;
  idempotencyKey: string;
}

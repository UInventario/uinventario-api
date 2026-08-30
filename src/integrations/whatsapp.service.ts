import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SendWhatsappMessageDto } from './dto/send-whatsapp-message.dto';
import type { WhatsappWebhookDto } from './dto/whatsapp-webhook.dto';
import { ExternalAdapterExecutionService } from './external-adapter-execution.service';
import {
  WhatsappConsentRequiredError,
  WhatsappIdempotencyConflictError,
  WhatsappMessageNotFoundError,
  WhatsappPhoneRequiredError,
  WhatsappRateLimitError,
  WhatsappWebhookConflictError,
} from './whatsapp.errors';
import { WhatsappRepository } from './whatsapp.repository';

@Injectable()
export class WhatsappService {
  constructor(
    private readonly repository: WhatsappRepository,
    private readonly executor: ExternalAdapterExecutionService,
  ) {}

  contract() {
    return {
      data: {
        name: 'UINVENTARIO_WHATSAPP',
        version: '1',
        provider: { key: 'SIMULATOR', mode: 'SIMULATOR', production: false },
        templates: [
          'WHATSAPP_SALE_RECEIPT',
          'WHATSAPP_ORDER_STATUS',
          'WHATSAPP_OPERATIONAL_NOTICE',
        ],
        guarantees: {
          explicitConsent: true,
          optOutImmediate: true,
          idempotentWebhook: true,
          rateLimitPerCustomerHour: 20,
          arbitraryBodyAccepted: false,
          otherChannelsIndependent: true,
        },
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async consents(tenantId: string) {
    return {
      data: await this.repository.consents(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async setConsent(input: {
    tenantId: string;
    customerId: string;
    userId: string;
    enabled: boolean;
  }) {
    try {
      return {
        data: await this.repository.setConsent(input),
        meta: { apiVersion: '1' as const },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async send(input: {
    tenantId: string;
    userId: string;
    customerId: string;
    idempotencyKey: string;
    correlationId: string;
    dto: SendWhatsappMessageDto;
  }) {
    this.key(input.idempotencyKey);
    const fingerprint = this.hash({
      customerId: input.customerId,
      dto: input.dto,
    });
    const token = randomBytes(24).toString('base64url');
    try {
      const begun = await this.repository.begin({
        tenantId: input.tenantId,
        customerId: input.customerId,
        templateKey: input.dto.templateKey,
        reference: input.dto.reference?.trim() || null,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        webhookTokenHash: this.hash(token),
      });
      if (begun.replay) {
        return {
          data: begun.message,
          meta: {
            apiVersion: '1' as const,
            idempotentReplay: true,
            simulatorWebhookToken: null,
          },
        };
      }
      const content = this.content(input.dto.templateKey, input.dto.reference);
      const execution = await this.executor.execute({
        tenantId: input.tenantId,
        capability: 'NOTIFICATION_WHATSAPP',
        idempotencyKey: `whatsapp:${input.idempotencyKey}`,
        correlationId: input.correlationId,
        scenario: input.dto.scenario,
        payload: {
          recipient: begun.phone!,
          title: content.title,
          body: content.body,
          template: { key: input.dto.templateKey, version: '1' },
        },
      });
      return {
        data: await this.repository.finish(
          input.tenantId,
          begun.message.id,
          execution,
        ),
        meta: {
          apiVersion: '1' as const,
          idempotentReplay: false,
          simulatorWebhookToken:
            execution.status === 'SUCCEEDED' ? token : null,
        },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async messages(tenantId: string) {
    return {
      data: await this.repository.messages(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async webhook(input: {
    tenantId: string;
    token: string;
    dto: WhatsappWebhookDto;
  }) {
    const target = await this.repository.webhookTarget(
      input.tenantId,
      input.dto.providerReference,
    );
    if (!target) throw new NotFoundException();
    if (!this.tokenMatches(input.token, target.webhookTokenHash)) {
      throw new ForbiddenException({
        code: 'WHATSAPP_WEBHOOK_SIGNATURE_INVALID',
      });
    }
    let result: { replay: boolean; ignoredOutOfOrder: boolean };
    try {
      result = await this.repository.webhook({
        tenantId: input.tenantId,
        messageId: target.message.id,
        providerEventId: input.dto.providerEventId,
        status: input.dto.status,
        occurredAt: new Date(input.dto.occurredAt),
      });
    } catch (error) {
      this.rethrow(error);
    }
    return {
      data: (await this.repository.messages(input.tenantId)).find(
        ({ id }) => id === target.message.id,
      )!,
      meta: {
        apiVersion: '1' as const,
        idempotentReplay: result.replay,
        ignoredOutOfOrder: result.ignoredOutOfOrder,
      },
    };
  }

  private content(template: string, reference?: string) {
    const ref = reference?.trim() || 'sin referencia';
    return template === 'WHATSAPP_SALE_RECEIPT'
      ? { title: 'Comprobante', body: `Comprobante disponible: ${ref}` }
      : template === 'WHATSAPP_ORDER_STATUS'
        ? { title: 'Estado de pedido', body: `Actualización de pedido: ${ref}` }
        : { title: 'Aviso operativo', body: `Aviso autorizado: ${ref}` };
  }

  private key(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
  }

  private tokenMatches(value: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(value));
    const expected = Buffer.from(expectedHash);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private hash(value: unknown): string {
    return createHash('sha256')
      .update(typeof value === 'string' ? value : JSON.stringify(value))
      .digest('hex');
  }

  private rethrow(error: unknown): never {
    if (error instanceof WhatsappConsentRequiredError)
      throw new ConflictException({ code: 'WHATSAPP_CONSENT_REQUIRED' });
    if (error instanceof WhatsappPhoneRequiredError)
      throw new BadRequestException({ code: 'WHATSAPP_PHONE_REQUIRED' });
    if (error instanceof WhatsappRateLimitError)
      throw new HttpException(
        { code: 'WHATSAPP_RATE_LIMITED' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (error instanceof WhatsappIdempotencyConflictError)
      throw new ConflictException({ code: 'WHATSAPP_IDEMPOTENCY_CONFLICT' });
    if (error instanceof WhatsappWebhookConflictError)
      throw new ConflictException({ code: 'WHATSAPP_WEBHOOK_CONFLICT' });
    if (error instanceof WhatsappMessageNotFoundError)
      throw new NotFoundException();
    throw error;
  }
}

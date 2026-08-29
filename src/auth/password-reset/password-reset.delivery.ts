import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { passwordResetConfig } from '../../config/password-reset.config';
import { ExternalAdapterExecutionService } from '../../integrations/external-adapter-execution.service';
import { TransactionalEmailTemplateService } from '../../integrations/transactional-email-template.service';

export interface PasswordResetDelivery {
  deliver(input: {
    tenantId: string;
    email: string;
    token: string;
    expiresAt: Date;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<void>;
}

export const PASSWORD_RESET_DELIVERY = Symbol('PASSWORD_RESET_DELIVERY');

@Injectable()
export class ConfiguredPasswordResetDelivery implements PasswordResetDelivery {
  private readonly messages = new Map<
    string,
    { token: string; resetUrl: string; expiresAt: string }
  >();

  constructor(
    @Inject(passwordResetConfig.KEY)
    private readonly config: ConfigType<typeof passwordResetConfig>,
    private readonly adapters: ExternalAdapterExecutionService,
    private readonly templates: TransactionalEmailTemplateService,
  ) {}

  async deliver(input: {
    tenantId: string;
    email: string;
    token: string;
    expiresAt: Date;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<void> {
    const separator = this.config.publicUrl.includes('?') ? '&' : '?';
    const resetUrl = `${this.config.publicUrl}${separator}token=${encodeURIComponent(input.token)}`;
    if (this.config.delivery === 'local') {
      this.messages.set(input.email.toLowerCase(), {
        token: input.token,
        resetUrl,
        expiresAt: input.expiresAt.toISOString(),
      });
      return;
    }
    if (this.config.delivery !== 'adapter') return;
    const content = this.templates.passwordReset({
      resetUrl,
      expiresAt: input.expiresAt,
    });
    await this.adapters.execute({
      tenantId: input.tenantId,
      capability: 'NOTIFICATION_EMAIL',
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      payload: {
        recipient: input.email,
        title: content.title,
        body: content.body,
        template: content.template,
      },
    });
  }

  localMessage(email: string) {
    if (this.config.production || this.config.delivery !== 'local') {
      throw new NotFoundException();
    }
    const message = this.messages.get(email.toLowerCase());
    if (!message) throw new NotFoundException();
    return message;
  }
}

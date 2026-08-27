import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { passwordResetConfig } from '../../config/password-reset.config';

export interface PasswordResetDelivery {
  deliver(input: {
    email: string;
    token: string;
    expiresAt: Date;
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
  ) {}

  deliver(input: {
    email: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    if (this.config.delivery !== 'local') return Promise.resolve();
    const separator = this.config.publicUrl.includes('?') ? '&' : '?';
    this.messages.set(input.email.toLowerCase(), {
      token: input.token,
      resetUrl: `${this.config.publicUrl}${separator}token=${encodeURIComponent(input.token)}`,
      expiresAt: input.expiresAt.toISOString(),
    });
    return Promise.resolve();
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

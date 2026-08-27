import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { argon2id, hash } from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { passwordResetConfig } from '../../config/password-reset.config';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { PASSWORD_RESET_DELIVERY } from './password-reset.delivery';
import type { PasswordResetDelivery } from './password-reset.delivery';
import { PasswordResetRepository } from './password-reset.repository';

const ARGON_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly resets: PasswordResetRepository,
    @Inject(PASSWORD_RESET_DELIVERY)
    private readonly delivery: PasswordResetDelivery,
    @Inject(passwordResetConfig.KEY)
    private readonly config: ConfigType<typeof passwordResetConfig>,
  ) {}

  async request(dto: RequestPasswordResetDto) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.ttlMilliseconds);
    const user = await this.resets.createToken({
      normalizedEmail: dto.email,
      tokenHash: this.hashToken(token),
      expiresAt,
      now,
    });
    if (user)
      await this.delivery.deliver({ email: user.email, token, expiresAt });
    return {
      data: { accepted: true },
      meta: { apiVersion: '1' as const },
    };
  }

  async complete(dto: CompletePasswordResetDto) {
    const changed = await this.resets.consumeToken({
      tokenHash: this.hashToken(dto.token),
      passwordHash: await hash(dto.password, ARGON_OPTIONS),
      now: new Date(),
    });
    if (!changed) {
      throw new BadRequestException({
        code: 'INVALID_PASSWORD_RESET_TOKEN',
        message: 'El enlace de recuperación no es válido o expiró.',
      });
    }
    return { data: { reset: true }, meta: { apiVersion: '1' as const } };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

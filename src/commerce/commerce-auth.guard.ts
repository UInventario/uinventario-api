import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { CommerceRepository } from './commerce.repository';
import type { CommerceRequest } from './commerce-request.types';
import { COMMERCE_SCOPES_KEY } from './commerce-scopes.decorator';
import type { CommerceScope } from './commerce.types';

@Injectable()
export class CommerceAuthGuard implements CanActivate {
  constructor(
    private readonly repository: CommerceRepository,
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CommerceRequest>();
    const rawKey = this.apiKey(request.headers.authorization);
    if (!rawKey) throw new UnauthorizedException('INVALID_API_CREDENTIAL');
    const match = /^uic_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{32,128}$/.exec(rawKey);
    if (!match) throw new UnauthorizedException('INVALID_API_CREDENTIAL');
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const principal = await this.repository.authenticate(
      `uic_${match[1]}`,
      keyHash,
    );
    if (!principal || !this.constantTimeEqual(principal.keyHash, keyHash))
      throw new UnauthorizedException('INVALID_API_CREDENTIAL');
    const required = this.reflector.getAllAndOverride<CommerceScope[]>(
      COMMERCE_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required?.some((scope) => !principal.scopes.includes(scope)))
      throw new ForbiddenException('INSUFFICIENT_API_SCOPE');
    const count = await this.repository.consumeRateLimit(principal);
    if (count > principal.rateLimitPerMinute)
      throw new HttpException(
        'API_RATE_LIMIT_EXCEEDED',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    request.commercePrincipal = principal;
    await this.audit.record({
      tenantId: principal.tenantId,
      actorUserId: principal.actorUserId,
      action: 'EXTERNAL_API_ACCESSED',
      entityType: 'COMMERCE_API_CREDENTIAL',
      entityId: principal.credentialId,
      correlationId: request.requestId ?? `external:${principal.credentialId}`,
      origin: 'INTEGRATION',
      after: {
        method: request.method,
        path: request.path,
        scopes: required ?? [],
      },
    });
    return true;
  }

  private apiKey(value: string | undefined): string | null {
    if (!value?.startsWith('Bearer ')) return null;
    const key = value.slice(7);
    return /^uic_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{32,128}$/.test(key) ? key : null;
  }

  private constantTimeEqual(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

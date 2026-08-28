import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';

type ThrottleRequest = {
  body?: { email?: unknown };
  headers?: { cookie?: unknown };
  ip?: unknown;
  originalUrl?: unknown;
  path?: unknown;
  socket?: { remoteAddress?: unknown };
};

export function securityThrottleTracker(request: ThrottleRequest): string {
  const email =
    typeof request.body?.email === 'string'
      ? request.body.email.trim().toLowerCase()
      : '';
  const cookie =
    typeof request.headers?.cookie === 'string' ? request.headers.cookie : '';
  const network =
    typeof request.ip === 'string'
      ? request.ip
      : typeof request.socket?.remoteAddress === 'string'
        ? request.socket.remoteAddress
        : 'unknown';
  const path =
    typeof request.originalUrl === 'string'
      ? request.originalUrl.split('?')[0]
      : typeof request.path === 'string'
        ? request.path
        : '';
  const identityEndpoint =
    /^\/api\/v1\/auth\/(?:registrations|sessions|password-resets)\/?$/.test(
      path,
    );

  const scope =
    identityEndpoint && email
      ? `identity:${email}`
      : cookie
        ? `session:${cookie}`
        : `network:${network}`;

  return createHash('sha256').update(scope).digest('hex');
}

@Injectable()
export class SecurityThrottlerGuard extends ThrottlerGuard {
  protected getTracker(request: ThrottleRequest): Promise<string> {
    return Promise.resolve(securityThrottleTracker(request));
  }
}

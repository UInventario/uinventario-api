import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { sessionConfig } from '../../config/session.config';
import { SessionService } from './session.service';
import type { AuthenticatedRequest } from './session.types';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    @Inject(sessionConfig.KEY)
    private readonly config: ConfigType<typeof sessionConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.readCookie(request.headers.cookie);
    request.principal = await this.sessions.authenticate(token);
    request.sessionToken = token!;
    return true;
  }

  private readCookie(header: string | undefined): string | undefined {
    if (!header) return undefined;

    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      const name = part.slice(0, separator).trim();
      if (name === this.config.cookieName) {
        return part.slice(separator + 1).trim();
      }
    }
    return undefined;
  }
}

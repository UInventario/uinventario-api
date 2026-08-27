import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/session/session.types';

@Injectable()
export class AuditAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.principal.user.roles.includes('ADMIN')) {
      throw new ForbiddenException({
        code: 'AUDIT_ACCESS_DENIED',
        message: 'No tienes permisos para consultar la auditoría.',
      });
    }
    return true;
  }
}

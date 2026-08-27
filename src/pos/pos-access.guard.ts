import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/session/session.types';

@Injectable()
export class PosAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = request.principal;
    if (
      identity.nextStep !== 'APPLICATION' ||
      !identity.context.branch ||
      !identity.context.warehouse ||
      !identity.context.cashRegister ||
      !identity.user.permissions.includes('SALES_MANAGE')
    ) {
      throw new ForbiddenException({
        code: 'POS_ACCESS_DENIED',
        message:
          'No tienes permiso o contexto operativo para usar el punto de venta.',
      });
    }
    return true;
  }
}

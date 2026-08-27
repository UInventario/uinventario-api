import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/session/session.types';

@Injectable()
export class SupplierAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const permissions = request.principal.user.permissions;
    const canReadForPurchases =
      request.method === 'GET' &&
      permissions.includes('PURCHASE_ORDERS_MANAGE');
    if (
      request.principal.nextStep !== 'APPLICATION' ||
      !request.principal.context.branch ||
      !request.principal.context.warehouse ||
      (!permissions.includes('SUPPLIERS_MANAGE') && !canReadForPurchases)
    ) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        message: 'No tienes permisos para realizar esta operación.',
      });
    }
    return true;
  }
}

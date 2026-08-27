import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/session/session.types';

@Injectable()
export class ProductAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const permissions = request.principal.user.permissions;
    const canReadForInventory =
      request.method === 'GET' && permissions.includes('INVENTORY_VIEW');
    if (
      request.principal.nextStep !== 'APPLICATION' ||
      (!permissions.includes('PRODUCTS_MANAGE') && !canReadForInventory)
    ) {
      throw new ForbiddenException({
        code: 'PRODUCT_ACCESS_DENIED',
        message: 'No tienes permiso para administrar productos.',
      });
    }
    return true;
  }
}

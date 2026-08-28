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
    const canReadForOperations =
      request.method === 'GET' &&
      (permissions.includes('INVENTORY_VIEW') ||
        permissions.includes('SUPPLIERS_MANAGE') ||
        permissions.includes('SALES_MANAGE'));
    if (
      request.principal.nextStep !== 'APPLICATION' ||
      (!permissions.includes('PRODUCTS_MANAGE') && !canReadForOperations)
    ) {
      throw new ForbiddenException({
        code: 'PRODUCT_ACCESS_DENIED',
        message: 'No tienes permiso para administrar productos.',
      });
    }
    return true;
  }
}

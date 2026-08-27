import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/session/session.types';

@Injectable()
export class InventoryAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (
      request.principal.nextStep !== 'APPLICATION' ||
      !request.principal.context.warehouse ||
      !request.principal.user.permissions.includes('STOCK_MANAGE')
    ) {
      throw new ForbiddenException({
        code: 'INVENTORY_ACCESS_DENIED',
        message: 'No tienes permiso para administrar inventario.',
      });
    }
    return true;
  }
}

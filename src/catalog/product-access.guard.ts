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
    if (
      request.principal.nextStep !== 'APPLICATION' ||
      !request.principal.user.permissions.includes('PRODUCTS_MANAGE')
    ) {
      throw new ForbiddenException({
        code: 'PRODUCT_ACCESS_DENIED',
        message: 'No tienes permiso para administrar productos.',
      });
    }
    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/session/session.types';

@Injectable()
export class OnboardingAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.principal.user.permissions.includes('TENANT_MANAGE')) {
      throw new ForbiddenException({
        code: 'ONBOARDING_ACCESS_DENIED',
        message: 'No tienes permiso para configurar la empresa.',
      });
    }
    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../session/session.types';
import type { AppPermission } from './authorization.types';
import { REQUIRED_PERMISSIONS } from './require-permissions.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const required = this.reflector.getAllAndOverride<AppPermission[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (
      request.principal.nextStep !== 'APPLICATION' ||
      !request.principal.context.branch ||
      !request.principal.context.warehouse ||
      !required?.every((permission) =>
        request.principal.user.permissions.includes(permission),
      )
    ) {
      const inventory = required?.some((permission) =>
        permission.startsWith('INVENTORY_'),
      );
      throw new ForbiddenException({
        code: inventory ? 'INVENTORY_ACCESS_DENIED' : 'PERMISSION_DENIED',
        message: 'No tienes permisos para realizar esta operación.',
      });
    }
    return true;
  }
}
